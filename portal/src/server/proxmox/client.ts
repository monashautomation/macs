import { Agent, fetch } from "undici";
import WebSocket from "ws";
import type { ClusterConfig } from "@/server/config";
import {
  bufferedStream,
  type ConsoleStream,
  type FirewallRule,
  type Params,
  type ProxmoxDriver,
  ProxmoxError,
  type PveBackup,
  type PveConfig,
  type PveNode,
  type PveVm,
  type Timeframe,
  type VmMetric,
} from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thin client for the Proxmox VE REST API. */
export class ProxmoxClient implements ProxmoxDriver {
  private readonly base: string;
  private readonly agent: Agent;
  private ticket?: { at: number; headers: Record<string, string> };
  /** Test hooks. */
  pollMs = 2000;
  taskTimeoutMs = 30 * 60_000;
  fetchImpl: typeof fetch = fetch;

  constructor(private readonly cfg: ClusterConfig) {
    this.base = `${cfg.endpoint.replace(/\/$/, "")}/api2/json`;
    this.agent = new Agent({ connect: { rejectUnauthorized: cfg.verify_tls }, connectTimeout: 10_000 });
  }

  private async auth(): Promise<Record<string, string>> {
    if (this.cfg.token_id)
      return { Authorization: `PVEAPIToken=${this.cfg.token_id}=${this.cfg.token_secret}` };
    // Tickets last 2h; refresh after 1h.
    if (this.ticket && Date.now() - this.ticket.at < 3600_000) return this.ticket.headers;
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await this.fetchImpl(`${this.base}/access/ticket`, {
        method: "POST",
        body: new URLSearchParams({ username: this.cfg.username, password: this.cfg.password }),
        dispatcher: this.agent,
      });
    } catch (e) {
      throw new ProxmoxError(`${this.cfg.id}: cannot reach Proxmox: ${(e as Error).message}`);
    }
    if (!res.ok) throw new ProxmoxError(`${this.cfg.id}: Proxmox login failed (${res.status})`);
    const { data } = (await res.json()) as { data: { ticket: string; CSRFPreventionToken: string } };
    this.ticket = {
      at: Date.now(),
      headers: {
        CSRFPreventionToken: data.CSRFPreventionToken,
        Cookie: `PVEAuthCookie=${encodeURIComponent(data.ticket)}`,
      },
    };
    return this.ticket.headers;
  }

  private async call<T = unknown>(
    method: string,
    path: string,
    params: Params | Record<string, Params[string] | string[]> = {},
  ): Promise<T> {
    const headers = await this.auth();
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined) continue;
      // Array parameters (e.g. agent exec's command) are sent as repeated keys.
      if (Array.isArray(v)) for (const item of v) form.append(k, item);
      else form.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
    const inQuery = method === "GET" || method === "DELETE";
    const url = `${this.base}${path}${inQuery && form.size ? `?${form}` : ""}`;
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: inQuery ? undefined : form,
        dispatcher: this.agent,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new ProxmoxError(`${this.cfg.id}: cannot reach Proxmox: ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { data?: T; message?: string; errors?: unknown };
    if (!res.ok) {
      const detail = body.errors ? JSON.stringify(body.errors) : (body.message ?? res.statusText);
      throw new ProxmoxError(`${method} ${path}: ${res.status} ${detail}`.trim());
    }
    return body.data as T;
  }

  /** Call an endpoint and, if it returned a task id, wait for the task. */
  private async task(method: string, path: string, params: Params = {}): Promise<void> {
    const upid = await this.call<unknown>(method, path, params);
    if (typeof upid !== "string" || !upid.startsWith("UPID:")) return;
    const node = upid.split(":")[1];
    const deadline = Date.now() + this.taskTimeoutMs;
    for (;;) {
      const st = await this.call<{ status: string; exitstatus?: string }>(
        "GET",
        `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
      );
      if (st.status === "stopped") {
        const exit = st.exitstatus ?? "";
        // Tasks that finish with warnings still did their job.
        if (exit !== "OK" && !exit.startsWith("WARNINGS"))
          throw new ProxmoxError(`${method} ${path} failed: ${exit}`);
        return;
      }
      if (Date.now() > deadline) throw new ProxmoxError(`${method} ${path}: task timed out`);
      await sleep(this.pollMs);
    }
  }

  // -- inventory ---------------------------------------------------------

  async nodes(): Promise<PveNode[]> {
    const res = await this.call<Record<string, unknown>[]>("GET", "/nodes");
    return res.map((n) => ({
      node: String(n.node),
      status: String(n.status ?? "unknown"),
      cpu: Number(n.cpu ?? 0),
      maxcpu: Number(n.maxcpu ?? 0),
      mem: Number(n.mem ?? 0),
      maxmem: Number(n.maxmem ?? 0),
    }));
  }

  async vms(): Promise<PveVm[]> {
    const res = await this.call<Record<string, unknown>[]>("GET", "/cluster/resources", { type: "vm" });
    return res
      .filter((r) => r.type === "qemu")
      .map((r) => ({
        vmid: Number(r.vmid),
        name: String(r.name ?? ""),
        node: String(r.node),
        status: String(r.status ?? "unknown"),
        template: !!r.template,
        tags: String(r.tags ?? ""),
        cpu: Number(r.cpu ?? 0),
        maxcpu: Number(r.maxcpu ?? 0),
        mem: Number(r.mem ?? 0),
        maxmem: Number(r.maxmem ?? 0),
        uptime: Number(r.uptime ?? 0),
      }));
  }

  vmConfig(node: string, vmid: number) {
    return this.call<PveConfig>("GET", `/nodes/${node}/qemu/${vmid}/config`);
  }

  async setConfig(node: string, vmid: number, params: Params) {
    await this.call("PUT", `/nodes/${node}/qemu/${vmid}/config`, params);
  }

  // -- lifecycle ---------------------------------------------------------

  clone(node: string, templateVmid: number, newid: number, name: string, storage: string, target?: string) {
    return this.task("POST", `/nodes/${node}/qemu/${templateVmid}/clone`, {
      newid,
      name,
      full: 1,
      storage,
      target: target && target !== node ? target : undefined,
    });
  }

  createVm(node: string, vmid: number, params: Params) {
    return this.task("POST", `/nodes/${node}/qemu`, { vmid, ...params });
  }

  resizeDisk(node: string, vmid: number, disk: string, sizeGb: number) {
    return this.task("PUT", `/nodes/${node}/qemu/${vmid}/resize`, { disk, size: `${sizeGb}G` });
  }

  start(node: string, vmid: number) {
    return this.task("POST", `/nodes/${node}/qemu/${vmid}/status/start`);
  }

  shutdown(node: string, vmid: number, timeout = 120) {
    return this.task("POST", `/nodes/${node}/qemu/${vmid}/status/shutdown`, { timeout, forceStop: 1 });
  }

  stop(node: string, vmid: number) {
    return this.task("POST", `/nodes/${node}/qemu/${vmid}/status/stop`);
  }

  reboot(node: string, vmid: number) {
    return this.task("POST", `/nodes/${node}/qemu/${vmid}/status/reboot`);
  }

  migrate(node: string, vmid: number, target: string) {
    return this.task("POST", `/nodes/${node}/qemu/${vmid}/migrate`, { target, online: 0 });
  }

  destroy(node: string, vmid: number) {
    return this.task("DELETE", `/nodes/${node}/qemu/${vmid}`, { purge: 1, "destroy-unreferenced-disks": 1 });
  }

  async vmIps(node: string, vmid: number): Promise<string[]> {
    type Iface = { name?: string; "ip-addresses"?: { "ip-address"?: string }[] };
    let res: { result?: Iface[] } | null;
    try {
      res = await this.call("GET", `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`);
    } catch (e) {
      if (e instanceof ProxmoxError) return []; // guest agent not running (yet)
      throw e;
    }
    const ips: string[] = [];
    for (const iface of res?.result ?? []) {
      if (/^(lo|docker|br-|veth)/.test(iface.name ?? "")) continue;
      for (const a of iface["ip-addresses"] ?? []) {
        const ip = a["ip-address"] ?? "";
        if (ip && !/^(127\.|fe80|::1)/.test(ip)) ips.push(ip);
      }
    }
    return ips;
  }

  // -- backups -----------------------------------------------------------

  async backups(node: string, storage: string, vmid: number): Promise<PveBackup[]> {
    const res = await this.call<Record<string, unknown>[]>(
      "GET",
      `/nodes/${node}/storage/${storage}/content`,
      {
        content: "backup",
        vmid,
      },
    );
    return res
      .map((b) => ({
        volid: String(b.volid),
        ctime: Number(b.ctime ?? 0),
        size: Number(b.size ?? 0),
        notes: String(b.notes ?? ""),
      }))
      .sort((a, b) => a.ctime - b.ctime);
  }

  async backup(
    node: string,
    vmid: number,
    storage: string,
    notes = "",
    mode: "snapshot" | "stop" = "snapshot",
  ) {
    const before = new Set((await this.backups(node, storage, vmid)).map((b) => b.volid));
    await this.task("POST", `/nodes/${node}/vzdump`, {
      vmid,
      storage,
      mode,
      "notes-template": notes || undefined,
    });
    const fresh = (await this.backups(node, storage, vmid)).filter((b) => !before.has(b.volid));
    const last = fresh.at(-1);
    if (!last) throw new ProxmoxError("backup task finished but no new backup was found");
    return last;
  }

  restore(node: string, vmid: number, volid: string, storage: string, force = false) {
    return this.task("POST", `/nodes/${node}/qemu`, {
      vmid,
      archive: volid,
      storage,
      force: force ? 1 : undefined,
    });
  }

  async storageContent(node: string, storage: string, content: string) {
    const res = await this.call<Record<string, unknown>[]>(
      "GET",
      `/nodes/${node}/storage/${storage}/content`,
      {
        content,
      },
    );
    return res
      .map((v) => ({ volid: String(v.volid), size: Number(v.size ?? 0) }))
      .sort((a, b) => a.volid.localeCompare(b.volid));
  }

  // -- firewall ----------------------------------------------------------

  async firewallSetOptions(node: string, vmid: number, options: Params) {
    await this.call("PUT", `/nodes/${node}/qemu/${vmid}/firewall/options`, options);
  }

  async firewallRules(node: string, vmid: number) {
    return (
      (await this.call<FirewallRule[] | null>("GET", `/nodes/${node}/qemu/${vmid}/firewall/rules`)) ?? []
    );
  }

  async firewallAddRule(node: string, vmid: number, rule: FirewallRule) {
    await this.call("POST", `/nodes/${node}/qemu/${vmid}/firewall/rules`, { pos: 0, enable: 1, ...rule });
  }

  async firewallDeleteRule(node: string, vmid: number, pos: number) {
    await this.call("DELETE", `/nodes/${node}/qemu/${vmid}/firewall/rules/${pos}`);
  }

  async clusterFirewallEnabled() {
    return !!(await this.call<{ enable?: number } | null>("GET", "/cluster/firewall/options"))?.enable;
  }

  // -- usage history ----------------------------------------------------

  async vmMetrics(node: string, vmid: number, timeframe: Timeframe): Promise<VmMetric[]> {
    const rows = await this.call<Record<string, number | null>[]>(
      "GET",
      `/nodes/${node}/qemu/${vmid}/rrddata`,
      {
        timeframe,
        cf: "AVERAGE",
      },
    );
    // Proxmox pads the series with empty samples (no cpu) for time the VM was off.
    return (rows ?? [])
      .filter((r) => typeof r.time === "number" && typeof r.cpu === "number")
      .map((r) => ({
        time: Number(r.time),
        cpu: Number(r.cpu ?? 0),
        mem: Number(r.mem ?? 0),
        maxmem: Number(r.maxmem ?? 0),
        netin: Number(r.netin ?? 0),
        netout: Number(r.netout ?? 0),
      }))
      .sort((a, b) => a.time - b.time);
  }

  async nodeMetrics(node: string, timeframe: Timeframe) {
    const rows = await this.call<Record<string, number | null>[]>("GET", `/nodes/${node}/rrddata`, {
      timeframe,
      cf: "AVERAGE",
    });
    return (rows ?? [])
      .filter((r) => typeof r.time === "number" && typeof r.cpu === "number")
      .map((r) => ({
        time: Number(r.time),
        cpu: Number(r.cpu ?? 0),
        mem: Number(r.memused ?? 0),
        maxmem: Number(r.memtotal ?? 0),
      }))
      .sort((a, b) => a.time - b.time);
  }

  // -- guest agent --------------------------------------------------------

  async runInGuest(
    node: string,
    vmid: number,
    script: string,
    opts: { agentWaitMs?: number; timeoutMs?: number } = {},
  ) {
    const base = `/nodes/${node}/qemu/${vmid}/agent`;
    // The agent starts some time after the VM does; ping until it answers.
    const agentDeadline = Date.now() + (opts.agentWaitMs ?? 5 * 60_000);
    for (;;) {
      try {
        await this.call("POST", `${base}/ping`);
        break;
      } catch (e) {
        if (!(e instanceof ProxmoxError) || Date.now() > agentDeadline) {
          throw new ProxmoxError(
            "the VM's guest agent did not respond; is qemu-guest-agent installed in the image?",
          );
        }
        await sleep(Math.max(this.pollMs, 1) * 2);
      }
    }
    // The script goes in on stdin so it needs no quoting.
    const { pid } = await this.call<{ pid: number }>("POST", `${base}/exec`, {
      command: ["/bin/bash", "-s"],
      "input-data": script,
    });
    const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
    for (;;) {
      const st = await this.call<{
        exited: number | boolean;
        exitcode?: number;
        "out-data"?: string;
        "err-data"?: string;
      }>("GET", `${base}/exec-status`, { pid });
      if (st.exited) {
        return {
          exitCode: Number(st.exitcode ?? 0),
          output: `${st["out-data"] ?? ""}${st["err-data"] ?? ""}`,
        };
      }
      if (Date.now() > deadline) throw new ProxmoxError("the setup script did not finish in time");
      await sleep(this.pollMs);
    }
  }

  // -- console -----------------------------------------------------------

  async openConsole(node: string, vmid: number): Promise<ConsoleStream> {
    // vncproxy starts a short-lived VNC listener on the node; the websocket
    // must attach within a few seconds, using the same credentials.
    const data = await this.call<{ port: string | number; ticket: string }>(
      "POST",
      `/nodes/${node}/qemu/${vmid}/vncproxy`,
      { websocket: 1 },
    );
    const url =
      `${this.base.replace(/^http/, "ws")}/nodes/${node}/qemu/${vmid}/vncwebsocket` +
      `?port=${data.port}&vncticket=${encodeURIComponent(data.ticket)}`;
    const ws = new WebSocket(url, ["binary"], {
      headers: await this.auth(),
      rejectUnauthorized: this.cfg.verify_tls,
      handshakeTimeout: 10_000,
    });
    const out = bufferedStream(
      data.ticket,
      (buf) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      },
      () => ws.close(),
    );
    // Listen before the handshake completes: the VNC banner arrives immediately.
    ws.on("message", (msg) => out.push(Buffer.isBuffer(msg) ? msg : Buffer.concat(msg as Buffer[])));
    ws.on("close", () => out.end());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", (e) =>
        reject(new ProxmoxError(`${this.cfg.id}: could not open the console: ${e.message}`)),
      );
    });
    ws.on("error", () => ws.close());
    return out.stream;
  }
}
