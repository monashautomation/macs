import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { type ClusterConfig, config, type MacsConfig } from "@/server/config";
import { ProxmoxClient } from "@/server/proxmox/client";
import { MockProxmox } from "@/server/proxmox/mock";
import type { ConsoleStream, ProxmoxDriver, PveVm } from "@/server/proxmox/types";

export type Log = (msg: string) => void;

/** The VM already has an operation in flight. */
export class Busy extends Error {}

/**
 * Process-wide engine state: Proxmox drivers, short-lived caches, locks,
 * running jobs and parked console sessions. All of it is in memory, which is
 * why the app runs as a single replica.
 */
export class Core {
  readonly drivers: Map<string, ProxmoxDriver>;
  /** Wakes the scheduler early (set by the scheduler loop). */
  kick: () => void = () => {};
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly consoles = new Map<
    string,
    { userId: string; stream: ConsoleStream; timer: NodeJS.Timeout }
  >();

  constructor(
    readonly cfg: MacsConfig,
    drivers?: Map<string, ProxmoxDriver>,
  ) {
    this.drivers =
      drivers ??
      new Map(
        cfg.clusters.map((c) => [
          c.id,
          c.driver === "mock"
            ? new MockProxmox(c, { delayMs: 600, demo: true, stateFile: `.mock-state-${c.id}.json` })
            : new ProxmoxClient(c),
        ]),
      );
  }

  cluster(id: string): ClusterConfig {
    const c = this.cfg.clusters.find((x) => x.id === id);
    if (!c) throw new Error(`unknown cluster ${id}`);
    return c;
  }

  findCluster(id: string): ClusterConfig | undefined {
    return this.cfg.clusters.find((x) => x.id === id);
  }

  driver(id: string): ProxmoxDriver {
    const d = this.drivers.get(id);
    if (!d) throw new Error(`unknown cluster ${id}`);
    return d;
  }

  // -- short-lived cache for live Proxmox reads ---------------------------

  async cached<T>(clusterId: string, key: string, fetch: () => Promise<T>, maxAgeMs = 5000): Promise<T> {
    const k = `${clusterId}\u0000${key}`;
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.value as T;
    const value = await fetch();
    this.cache.set(k, { at: Date.now(), value });
    return value;
  }

  invalidate(clusterId: string) {
    for (const k of this.cache.keys()) if (k.startsWith(`${clusterId}\u0000`)) this.cache.delete(k);
  }

  liveVms(clusterId: string): Promise<Map<number, PveVm>> {
    return this.cached(
      clusterId,
      "vms",
      async () => new Map((await this.driver(clusterId).vms()).map((v) => [v.vmid, v])),
    );
  }

  // -- locks ---------------------------------------------------------------

  /** Run `fn` after everything already queued under `key` has finished. */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  // -- audit + jobs --------------------------------------------------------

  async audit(userId: string | null, action: string, target = "", detail = "") {
    await db.audit.create({ data: { userId, action, target, detail } });
  }

  async vmBusy(vmId: string): Promise<boolean> {
    return (await db.job.count({ where: { vmId, status: "running" } })) > 0;
  }

  /** Registers a job. A VM can have one running job: the database enforces it. */
  async createJob(
    kind: string,
    vm: { id: string; name: string } | null,
    userId: string | null,
  ): Promise<string> {
    try {
      const job = await db.job.create({ data: { kind, vmId: vm?.id ?? null, userId }, select: { id: true } });
      return job.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new Busy(`${vm?.name ?? "that VM"} already has an operation in progress`);
      }
      throw e;
    }
  }

  /** Runs fn, streaming its log lines into the job row. Resolves to success. */
  async runJob(jobId: string, fn: (log: Log) => Promise<void>): Promise<boolean> {
    let queue: Promise<unknown> = Promise.resolve();
    const write: Log = (msg) => {
      const line = `${new Date().toISOString().slice(11, 19)} ${msg}\n`;
      queue = queue
        .then(() => db.$executeRaw`UPDATE jobs SET log = log || ${line} WHERE id = ${jobId}`)
        .catch((err) => logger.error({ err, jobId }, "could not write job log"));
    };
    let error = "";
    try {
      await fn(write);
    } catch (e) {
      error = (e as Error)?.message || String(e);
      logger.warn({ jobId, error }, "job failed");
      write(`FAILED: ${error}`);
    }
    await queue;
    const job = await db.job.update({
      where: { id: jobId },
      data: { status: error ? "failed" : "succeeded", error, finishedAt: new Date() },
      select: { vm: { select: { clusterId: true } } },
    });
    if (job.vm) this.invalidate(job.vm.clusterId);
    return !error;
  }

  spawnJob(jobId: string, fn: (log: Log) => Promise<void>) {
    const task = this.runJob(jobId, fn).catch((err) => logger.error({ err, jobId }, "job runner crashed"));
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  /** Test hook: wait for every background job to finish. */
  async waitJobs() {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  /** At startup: nothing in memory survives a restart, so close out orphans. */
  async recover() {
    await db.job.updateMany({
      where: { status: "running" },
      data: { status: "failed", error: "interrupted by a restart", finishedAt: new Date() },
    });
    await db.vm.updateMany({
      where: { status: "provisioning" },
      data: { status: "error", error: "provisioning was interrupted by a restart" },
    });
  }

  // -- consoles ------------------------------------------------------------

  /** Park an open console until its owner's websocket claims it (once). */
  holdConsole(userId: string, stream: ConsoleStream, ttlMs = 20_000): string {
    const token = randomBytes(32).toString("base64url");
    const timer = setTimeout(() => {
      if (this.consoles.delete(token)) stream.close();
    }, ttlMs);
    this.consoles.set(token, { userId, stream, timer });
    return token;
  }

  claimConsole(token: string): { userId: string; stream: ConsoleStream } | undefined {
    const entry = this.consoles.get(token);
    if (!entry) return undefined;
    this.consoles.delete(token);
    clearTimeout(entry.timer);
    return entry;
  }
}

const globalForCore = globalThis as unknown as { macsCore?: Core };

/** One engine per process, shared by route handlers and instrumentation. */
export function core(): Core {
  globalForCore.macsCore ??= new Core(config());
  return globalForCore.macsCore;
}

/** Test hook. */
export function setCoreForTests(c: Core | undefined) {
  globalForCore.macsCore = c;
}
