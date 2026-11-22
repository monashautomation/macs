import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { Busy } from "@/server/core";
import * as infra from "@/server/handlers/infra";
import * as h from "@/server/handlers/vms";
import { expectHttp, hasDb, KEY, Portal } from "./portal";

describe.skipIf(!hasDb)("VMs, approvals and GPU scheduling", () => {
  let p: Portal;
  beforeEach(async () => {
    p = await Portal.create();
  });
  const base = {
    clusterId: "homelab",
    name: "ok",
    imageSlug: "ubuntu",
    cores: 1,
    memoryMb: 1024,
    diskGb: 10,
    sshPublicKey: KEY,
    wantsGpu: false,
    justification: "",
  };

  it("shows clusters by Authentik group", async () => {
    const ids = async (u: string) => (await h.listClusters(p.who(u))).map((c) => c.id);
    expect(await ids("alice")).toEqual(["research", "homelab"]);
    expect(await ids("sam")).toEqual(["homelab"]);
    expect(await ids("admin")).toEqual(["research", "homelab"]);
    await expectHttp(
      h.createVm(p.who("sam"), { ...base, clusterId: "research", imageSlug: "jam", justification: "x" }),
      404,
    );
  });

  it("homelab is self-service within quota", async () => {
    const vm = await p.makeVm("sam", "homelab", "lab1", false);
    expect(vm).toMatchObject({ status: "active", power: "running", vmid: 1000, gpuAccess: "none" });
    expect(vm.ips.length).toBe(1);
    const config = p.homelab.guests.get(1000)!.config;
    expect(config.cores).toBe(2);
    expect(String(config.scsi0)).toContain("size=30G");
    expect(config.tags).toBe("macs;owner-sam");
    expect(String(config.sshkeys)).toMatch(/^ssh-ed25519%20/);
    expect(config.ciuser).toBe("ubuntu");

    await p.makeVm("sam", "homelab", "lab2", false);
    await expectHttp(h.createVm(p.who("sam"), { ...base, name: "lab3" }), 422, /quota/);
  });

  it("validates requests", async () => {
    const sam = p.who("sam");
    await expectHttp(h.createVm(sam, { ...base, name: "bad_name!" }), 422, /hostname/);
    await expectHttp(h.createVm(sam, { ...base, cores: 64 }), 422, /per-VM limit/);
    await expectHttp(h.createVm(sam, { ...base, sshPublicKey: "nope" }), 422, /SSH public key/);
    await expectHttp(h.createVm(sam, { ...base, imageSlug: "missing" }), 422, /library/);
    await p.run(h.createVm(sam, base));
    await expectHttp(h.createVm(sam, base), 409, /already exists/);
  });

  it("research requests need approval, with or without GPU", async () => {
    const alice = p.who("alice");
    const admin = p.who("admin");
    const body = {
      ...base,
      clusterId: "research",
      imageSlug: "jam",
      name: "sim",
      wantsGpu: true,
      justification: "training",
    };
    await expectHttp(h.createVm(alice, { ...body, justification: "" }), 422, /what the VM is for/);
    const vm = await p.run(h.createVm(alice, body));
    expect(vm).toMatchObject({ status: "pending", gpuAccess: "requested", vmid: null });
    expect(p.research.guests.has(1000)).toBe(false);
    expect((await infra.approvals()).vms.map((v) => v.id)).toEqual([vm.id]);

    // Approve the VM but not the GPU.
    await p.run(infra.reviewVm(admin, vm.id, { approve: true, grantGpu: false, note: "" }));
    let detail = await h.vmDetail(alice, vm.id);
    expect(detail).toMatchObject({ status: "active", gpuAccess: "none", power: "running" });
    expect(detail.reviewedBy?.name).toBe("admin");
    await expectHttp(p.book("alice", vm.id, 1, 2), 422, /not approved for GPU use/);

    // Ask for GPU access later.
    await h.requestGpuAccess(alice, vm.id, { justification: "now I need it" });
    await expectHttp(h.requestGpuAccess(alice, vm.id, { justification: "again" }), 409);
    await infra.reviewVm(admin, vm.id, { approve: true, grantGpu: false, note: "" });
    await p.book("alice", vm.id, 1, 2);

    const other = await h.createVm(p.who("bob"), { ...body, name: "nope" });
    await infra.reviewVm(admin, other.id, { approve: false, grantGpu: false, note: "no" });
    detail = await h.vmDetail(p.who("bob"), other.id);
    expect(detail).toMatchObject({ status: "rejected", reviewNote: "no" });
    await expectHttp(infra.reviewVm(admin, other.id, { approve: true, grantGpu: false, note: "" }), 409);
  });

  it("keeps people out of each other's VMs", async () => {
    const vm = await p.makeVm("alice");
    const bob = p.who("bob");
    await expectHttp(h.vmDetail(bob, vm.id), 404);
    await expectHttp(h.powerVm(bob, vm.id, "stop"), 404);
    await expectHttp(h.deleteVm(bob, vm.id), 404);
    await expectHttp(h.openConsole(bob, vm.id), 404);
    await expectHttp(p.book("bob", vm.id, 1, 2), 404);
    await expectHttp(h.listVms(bob, "all"), 403);
    expect(await h.listVms(bob, "mine")).toEqual([]);
    expect((await h.listVms(p.who("admin"), "all")).map((v) => v.id)).toEqual([vm.id]);
    // Other people are exposed as id/name/image only.
    expect(Object.keys((await h.vmDetail(p.who("admin"), vm.id)).owner).sort()).toEqual([
      "id",
      "image",
      "name",
    ]);
  });

  it("powers and deletes, one operation per VM at a time", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "lab", false);
    await p.run(h.powerVm(sam, vm.id, "shutdown"));
    expect((await h.vmDetail(sam, vm.id)).power).toBe("stopped");

    // The database refuses a second running job for the same VM.
    const first = await p.core.createJob("start", vm, sam.id);
    await expect(p.core.createJob("stop", vm, sam.id)).rejects.toBeInstanceOf(Busy);
    await expect(h.powerVm(sam, vm.id, "start")).rejects.toBeInstanceOf(Busy);
    await p.core.runJob(first, async () => {});

    await p.run(h.powerVm(sam, vm.id, "start"));
    await p.run(h.deleteVm(sam, vm.id));
    expect(p.homelab.guests.has(1000)).toBe(false);
    expect(await h.listVms(sam, "mine")).toEqual([]);
  });

  it("reports a failed provision", async () => {
    p.homelab.guests.delete(9000); // template went missing
    const vm = await p.run(h.createVm(p.who("sam"), base));
    const detail = await h.vmDetail(p.who("sam"), vm.id);
    expect(detail.status).toBe("error");
    expect(detail.error).toContain("template VM 9000 not found");
    expect(detail.jobs[0]).toMatchObject({ status: "failed", kind: "provision" });
    expect(detail.jobs[0]!.log).toContain("FAILED");
    expect(await h.deleteVm(p.who("sam"), vm.id)).toEqual({ jobId: null });
  });

  it("a booking attaches a GPU, migrating the VM, and releases it on time", async () => {
    const alice = p.who("alice");
    const vm = await p.makeVm("alice");
    const vmid = vm.vmid!;
    // Park the VM on a node with no GPU so the booking has to migrate it.
    await p.run(h.powerVm(alice, vm.id, "stop"));
    p.research.nodeNames.push("pve9");
    await p.research.migrate(p.research.guests.get(vmid)!.node, vmid, "pve9");
    p.core.invalidate("research");

    const res = await p.book("alice", vm.id, 1, 3);
    await p.tick();
    expect(await p.gpus()).toEqual({ "gpu-1": null, "gpu-2": null }); // not time yet

    await p.shift(res.id, 1.5);
    await p.tick();
    const holders = await p.gpus();
    const held = Object.keys(holders).filter((g) => holders[g]);
    expect(held.length).toBe(1);
    expect(holders[held[0]!]).toMatchObject({ vmId: vm.id, owner: { name: "alice" } });
    expect(holders[held[0]!]!.bookedUntil).toBeTruthy();
    const guest = p.research.guests.get(vmid)!;
    expect(guest.status).toBe("running");
    expect(["pve1", "pve2"]).toContain(guest.node);
    expect(guest.config.hostpci0).toBe("mapping=rtx4090,pcie=1");
    let detail = await h.vmDetail(alice, vm.id);
    expect(detail.gpu).toBe(held[0]);
    expect(detail.reservations[0]).toMatchObject({ status: "active", gpuId: held[0] });

    await p.shift(res.id, 2);
    await p.tick();
    expect(await p.gpus()).toEqual({ "gpu-1": null, "gpu-2": null });
    expect(guest.config.hostpci0).toBeUndefined();
    expect(guest.status).toBe("running"); // rebooted without the GPU
    detail = await h.vmDetail(alice, vm.id);
    expect(detail.reservations[0]!.status).toBe("completed");
    expect(detail.jobs.map((j) => j.kind)).toEqual(expect.arrayContaining(["gpu-attach", "gpu-release"]));
  });

  it("enforces booking capacity and limits", async () => {
    const a = await p.makeVm("alice", "research", "a");
    const b = await p.makeVm("bob", "research", "b");
    const c = await p.makeVm("alice", "research", "c");
    await p.book("alice", a.id, 1, 5);
    await p.book("bob", b.id, 2, 6);
    await expectHttp(p.book("alice", c.id, 4, 8), 422, /GPUs are booked/);
    await p.book("alice", c.id, 5, 8); // first slot frees up at +5h
    await expectHttp(p.book("alice", a.id, 4, 7), 422, /overlapping/);
    await expectHttp(p.book("alice", a.id, 10, 200), 422, /limited to/);
    await expectHttp(p.book("alice", a.id, 24 * 40, 24 * 40 + 1), 422, /days ahead/);
    await expectHttp(p.book("alice", a.id, -3, -1), 422, /in the past/);
    // Everyone on the cluster sees the schedule.
    const all = await h.listReservations(p.who("bob"), {
      clusterId: "research",
      start: new Date(),
      end: new Date(Date.now() + 86_400_000),
    });
    expect(all.length).toBe(3);
    await expectHttp(
      h.listReservations(p.who("sam"), { clusterId: "research", start: new Date(), end: new Date() }),
      404,
    );
  });

  it("cancelling an active booking releases the GPU", async () => {
    const vm = await p.makeVm("alice");
    const res = await p.book("alice", vm.id, 0, 2);
    await p.tick();
    expect(Object.values(await p.gpus()).some(Boolean)).toBe(true);
    await expectHttp(h.cancelReservation(p.who("bob"), res.id), 404);
    await h.cancelReservation(p.who("alice"), res.id);
    await p.tick();
    expect(Object.values(await p.gpus()).some(Boolean)).toBe(false);
  });

  it("back-to-back bookings keep the GPU without a reboot", async () => {
    const vm = await p.makeVm("alice");
    const first = await p.book("alice", vm.id, 0, 1);
    const second = await p.book("alice", vm.id, 1, 2);
    await p.tick();
    const jobsBefore = await db.job.count();
    await p.shift(first.id, 1.01);
    await p.shift(second.id, 1.01);
    await p.tick();
    const status = Object.fromEntries(
      (await h.vmDetail(p.who("alice"), vm.id)).reservations.map((r) => [r.id, r.status]),
    );
    expect(status).toEqual({ [first.id]: "completed", [second.id]: "active" });
    expect(Object.values(await p.gpus()).some(Boolean)).toBe(true);
    expect(await db.job.count()).toBe(jobsBefore);
  });

  it("the scheduler takes an unbooked GPU but never an unmanaged VM's", async () => {
    const admin = p.who("admin");
    const a = await p.makeVm("alice", "research", "a");
    const b = await p.makeVm("bob", "research", "b");
    const c = await p.makeVm("bob", "research", "c");
    // An unmanaged VM holds gpu-2; infra hands gpu-1 to alice's VM without a booking.
    p.research.seedVm(500, "legacy", "pve2", true, { hostpci0: "mapping=rtx4090,pcie=1" });
    await p.run(infra.assignGpu(admin, { vmId: a.id, gpuId: "gpu-1" }));
    let holders = await p.gpus();
    expect(holders["gpu-1"]).toMatchObject({ vmId: a.id });
    expect(holders["gpu-2"]).toMatchObject({ vmId: null, name: "legacy", owner: null });

    await p.book("bob", b.id, 0, 2);
    await p.tick();
    holders = await p.gpus();
    expect(holders["gpu-1"]).toMatchObject({ vmId: b.id });
    expect(holders["gpu-2"]).toMatchObject({ name: "legacy" });
    const evicted = p.research.guests.get(a.vmid!)!;
    expect(evicted.status).toBe("running");
    expect(evicted.config.hostpci0).toBeUndefined();

    // Both GPUs are now untouchable, so the next booking fails cleanly.
    const res = await p.book("bob", c.id, 0, 1);
    await p.tick();
    const got = (await h.vmDetail(p.who("bob"), c.id)).reservations[0]!;
    expect(got).toMatchObject({ id: res.id, status: "failed" });
    expect(got.error).toContain("no GPU is free");
  });

  it("infra can swap and release GPUs", async () => {
    const admin = p.who("admin");
    const a = await p.makeVm("alice", "research", "a");
    const b = await p.makeVm("bob", "research", "b");
    await expectHttp(infra.assignGpu(admin, { vmId: a.id, gpuId: "gpu-9" }), 404);
    await p.run(infra.assignGpu(admin, { vmId: a.id, gpuId: "gpu-2" }));
    expect((await p.gpus())["gpu-2"]).toMatchObject({ vmId: a.id });
    expect(p.research.guests.get(a.vmid!)!.node).toBe("pve2");
    await p.run(infra.assignGpu(admin, { vmId: b.id, gpuId: "gpu-2" }));
    expect((await p.gpus())["gpu-2"]).toMatchObject({ vmId: b.id });
    expect(p.research.guests.get(a.vmid!)!.status).toBe("running"); // evicted VM comes back up
    await p.run(infra.releaseGpu(admin, { clusterId: "research", vmid: b.vmid!, restart: false }));
    expect(await p.gpus()).toEqual({ "gpu-1": null, "gpu-2": null });
    expect(p.research.guests.get(b.vmid!)!.status).toBe("stopped");
  });

  it("backs up, rolls back, archives and restores", async () => {
    const alice = p.who("alice");
    const vm = await p.makeVm("alice");
    const vmid = vm.vmid!;
    await p.run(h.createBackup(alice, vm.id, { notes: "before upgrade" }));
    let detail = await h.vmDetail(alice, vm.id);
    expect(detail.backups).toMatchObject([{ notes: "before upgrade" }]);
    expect(detail.backups[0]).not.toHaveProperty("volid");

    // Roll back in place while holding a GPU: the passthrough must survive the restore.
    await p.run(infra.assignGpu(p.who("admin"), { vmId: vm.id }));
    await p.run(h.restore(alice, vm.id, { backupId: detail.backups[0]!.id }));
    expect(p.research.guests.get(vmid)!.config.hostpci0).toBeDefined();
    expect(p.research.guests.get(vmid)!.status).toBe("running");

    const res = await p.book("alice", vm.id, 5, 6);
    await p.run(h.archive(alice, vm.id));
    detail = await h.vmDetail(alice, vm.id);
    expect(detail.status).toBe("archived");
    expect(p.research.guests.has(vmid)).toBe(false);
    expect(detail.backups.length).toBe(2);
    expect(Object.values(await p.gpus()).some(Boolean)).toBe(false);
    expect(detail.reservations.find((r) => r.id === res.id)!.status).toBe("cancelled");

    // The archived VM keeps its VMID reserved, so a new VM cannot inherit its backups.
    const other = await p.makeVm("bob", "research", "other");
    expect(other.vmid).not.toBe(vmid);
    expect(other.backups).toEqual([]);
    await expectHttp(h.restore(p.who("bob"), other.id, { backupId: detail.backups[0]!.id }), 404);

    await p.run(h.restore(alice, vm.id, { backupId: detail.backups[0]!.id }));
    detail = await h.vmDetail(alice, vm.id);
    expect(detail).toMatchObject({ status: "active", power: "running" });
    expect(p.research.guests.get(vmid)!.config.hostpci0).toBeUndefined();
  });

  it("adopts an existing VM for a user", async () => {
    const admin = p.who("admin");
    p.research.seedVm(500, "legacy", "pve1", true, { hostpci0: "mapping=rtx4090,pcie=1" });
    expect((await infra.unmanaged("research")).map((v) => v.vmid)).toEqual([500]);
    await infra.adopt(admin, {
      clusterId: "research",
      vmid: 500,
      ownerId: p.who("alice").id,
      gpuAccess: true,
    });
    const [mine] = await h.listVms(p.who("alice"), "mine");
    expect(mine).toMatchObject({ name: "legacy", gpu: "gpu-1", diskGb: 40, gpuAccess: "approved" });
    expect(await infra.unmanaged("research")).toEqual([]);
    await expectHttp(
      infra.adopt(admin, { clusterId: "research", vmid: 500, ownerId: p.who("bob").id, gpuAccess: false }),
      409,
    );
  });

  it("closes out interrupted work after a restart", async () => {
    const vm = await p.makeVm("sam", "homelab", "lab", false);
    await p.core.createJob("backup", vm, null);
    await db.vm.create({
      data: {
        clusterId: "homelab",
        name: "half",
        ownerId: p.who("sam").id,
        cores: 1,
        memoryMb: 1024,
        diskGb: 10,
        status: "provisioning",
      },
    });
    await p.core.recover();
    expect(await db.job.count({ where: { status: "running" } })).toBe(0);
    expect(await db.vm.count({ where: { status: "error", name: "half" } })).toBe(1);
    expect(await p.core.vmBusy(vm.id)).toBe(false);
  });
});
