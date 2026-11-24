import { expect } from "vitest";
import { db } from "@/lib/db";
import type { Role } from "@/lib/roles";
import { parseConfig } from "@/server/config";
import { Core, setCoreForTests } from "@/server/core";
import * as infra from "@/server/handlers/infra";
import * as h from "@/server/handlers/vms";
import { HttpError, type Who } from "@/server/http";
import { MockProxmox } from "@/server/proxmox/mock";
import { seedImages } from "@/server/services/images";
import { tick } from "@/server/services/schedule";
import { seedSetups } from "@/server/services/setups";

export const hasDb = !!process.env.TEST_DATABASE_URL;
export const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtestkeytestkeytestkeytestkeytestkeytestkey0 test@macs";
export const NETBIRD = "100.64.3.7";
export const NEIGHBOUR = "10.20.0.50";

const CONFIG = `
clusters:
  - id: research
    name: Research
    kind: research
    driver: mock
    allowed_groups: [members]
    approval: required
    storage: ceph
    shared_storage: true
    backup_storage: pbs
    vmid_range: [1000, 1099]
    templates:
      - { id: jam, name: Golden Jam, vmid: 9000, default_user: baker, gpu_ready: true }
    gpu:
      mapping: rtx4090
      devices:
        - { id: gpu-1, node: pve1, model: RTX 4090 }
        - { id: gpu-2, node: pve2, model: RTX 4090 }
  - id: homelab
    name: Homelab
    kind: homelab
    driver: mock
    approval: none
    setups: true
    iso_storage: isos
    quota: { max_vms: 2, max_cores: 4 }
    limits: { max_cores: 4, max_memory_mb: 8192, max_disk_gb: 50 }
    network:
      isolate: true
      services: true
      access_sources: [100.64.0.0/10]
      public_sources: [100.64.0.0/10]
    templates:
      - { id: ubuntu, name: Ubuntu, vmid: 9000 }
`;

/** A fresh engine on mock clusters, with the handlers bound to it. */
export class Portal {
  cfg = parseConfig(CONFIG);
  research = new MockProxmox(this.cfg.clusters[0]!);
  homelab = new MockProxmox(this.cfg.clusters[1]!);
  core = new Core(
    this.cfg,
    new Map([
      ["research", this.research],
      ["homelab", this.homelab],
    ]),
  );
  private people = new Map<string, Who>();

  static async create() {
    await db.$executeRawUnsafe(
      'TRUNCATE "setups","audit","jobs","backups","reservations","services","images","vms","profiles","identity_groups","accounts","sessions","users" CASCADE',
    );
    const p = new Portal();
    setCoreForTests(p.core);
    await seedImages(p.cfg);
    await seedSetups();
    const everyone: [string, string[]][] = [
      ["admin", ["admins"]],
      ["alice", ["members"]],
      ["bob", ["members"]],
      ["sam", ["students"]],
    ];
    for (const [name, groups] of everyone) {
      const u = await db.user.create({ data: { name, email: `${name}@example.test` } });
      const roles = new Set<Role>(groups.includes("admins") ? ["member", "admin"] : ["member"]);
      p.people.set(name, { kind: "user", id: u.id, name, email: u.email, groups, roles });
    }
    return p;
  }

  who(name: string): Who {
    return this.people.get(name)!;
  }

  /** Await a handler, then let any background job it started finish. */
  async run<T>(work: Promise<T>): Promise<T> {
    const out = await work;
    await this.core.waitJobs();
    return out;
  }

  tick() {
    return tick(this.core);
  }

  /** Request a VM and, on approval clusters, approve it. Resolves to the VM detail. */
  async makeVm(owner: string, cluster = "research", name = "box", gpu = true) {
    const vm = await this.run(
      h.createVm(this.who(owner), {
        clusterId: cluster,
        name,
        imageSlug: cluster === "research" ? "jam" : "ubuntu",
        cores: 2,
        memoryMb: 2048,
        diskGb: 30,
        sshPublicKey: KEY,
        wantsGpu: gpu,
        justification: "thesis",
      }),
    );
    if (vm.status === "pending") {
      await this.run(infra.reviewVm(this.who("admin"), vm.id, { approve: true, grantGpu: gpu, note: "" }));
    }
    return h.vmDetail(this.who(owner), vm.id);
  }

  book(owner: string, vmId: string, startH: number, endH: number) {
    const now = Date.now();
    return h.createReservation(this.who(owner), {
      vmId,
      startAt: new Date(now + startH * 3600_000),
      endAt: new Date(now + endH * 3600_000),
      note: "",
    });
  }

  /** Move a booking earlier in time to simulate the clock advancing. */
  async shift(resId: string, hours: number) {
    const r = await db.reservation.findUniqueOrThrow({ where: { id: resId } });
    await db.reservation.update({
      where: { id: resId },
      data: {
        startAt: new Date(r.startAt.getTime() - hours * 3600_000),
        endAt: new Date(r.endAt.getTime() - hours * 3600_000),
      },
    });
  }

  /** GPU id -> holder (or null), as the infra team sees it. */
  async gpus() {
    const [cluster] = await h.listGpus(this.who("admin"));
    return Object.fromEntries(cluster!.devices.map((d) => [d.id, d.holder]));
  }
}

export async function expectHttp(work: Promise<unknown>, status: number, message?: RegExp | string) {
  const err = await work.then(
    () => null,
    (e) => e,
  );
  expect(err, `expected HTTP ${status}`).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  if (message) expect((err as HttpError).message).toMatch(message);
}
