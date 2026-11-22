import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import * as infra from "@/server/handlers/infra";
import * as h from "@/server/handlers/vms";
import { expectHttp, hasDb, KEY, NEIGHBOUR, NETBIRD, Portal } from "./portal";

describe.skipIf(!hasDb)("network isolation, services, image library, overview", () => {
  let p: Portal;
  beforeEach(async () => {
    p = await Portal.create();
  });
  const svc = (over: Partial<Parameters<typeof h.publishService>[2]> = {}) => ({
    name: "x",
    description: "",
    port: 8080,
    protocol: "tcp" as const,
    scheme: "" as const,
    ...over,
  });

  it("isolates homelab VMs but lets the owner in", async () => {
    const vm = await p.makeVm("sam", "homelab", "a", false);
    const guest = p.homelab.guests.get(vm.vmid!)!;
    expect(String(guest.config.net0)).toContain("firewall=1");
    expect(guest.firewall!.options).toMatchObject({ enable: 1, policy_in: "DROP" });
    expect(p.homelab.reachable(vm.vmid!, NETBIRD, 22)).toBe(true); // owner over NetBird
    expect(p.homelab.reachable(vm.vmid!, NEIGHBOUR, 22)).toBe(false); // another homelab VM
    expect(p.homelab.reachable(vm.vmid!, NETBIRD, 8080)).toBe(false); // nothing published yet
  });

  it("leaves research VMs unfiltered on the lab network", async () => {
    const vm = await p.makeVm("alice", "research", "box", false);
    expect(p.research.guests.get(vm.vmid!)!.firewall).toBeUndefined();
    expect(p.research.reachable(vm.vmid!, NEIGHBOUR, 8080)).toBe(true);
    await expectHttp(h.publishService(p.who("alice"), vm.id, svc()), 409);
  });

  it("publishes and unpublishes a service", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "web", false);
    const vmid = vm.vmid!;
    p.cfg.clusters[1]!.connect_domain = "netbird.selfhosted";
    const blog = await h.publishService(
      sam,
      vm.id,
      svc({ name: "Blog", scheme: "http", description: "my blog" }),
    );
    expect(blog).toMatchObject({ status: "published", url: "http://web.netbird.selfhosted:8080" });
    expect(p.homelab.reachable(vmid, NETBIRD, 8080)).toBe(true);
    expect(p.homelab.reachable(vmid, NEIGHBOUR, 8080)).toBe(false); // still closed to neighbours
    expect(p.homelab.reachable(vmid, NETBIRD, 8081)).toBe(false);
    expect(p.homelab.reachable(vmid, NETBIRD, 22)).toBe(true);

    // Visible in the directory to others on the cluster; only the owner can remove it.
    expect((await h.serviceDirectory(p.who("alice"))).map((s) => s.name)).toEqual(["Blog"]);
    await expectHttp(h.removeService(p.who("alice"), blog.id), 404);
    expect((await h.vmDetail(sam, vm.id)).services[0]).toMatchObject({ port: 8080 });

    // Guard rails.
    await expectHttp(h.publishService(sam, vm.id, svc()), 409); // duplicate
    await expectHttp(h.publishService(sam, vm.id, svc({ port: 22 })), 422, /access port/);
    await expectHttp(h.publishService(sam, vm.id, svc({ port: 53, protocol: "udp", scheme: "http" })), 422);
    await h.publishService(sam, vm.id, svc({ port: 53, protocol: "udp" }));
    expect(p.homelab.reachable(vmid, NETBIRD, 53, "udp")).toBe(true);
    expect(p.homelab.reachable(vmid, NETBIRD, 53, "tcp")).toBe(false);
    for (const port of [9001, 9002, 9003]) await h.publishService(sam, vm.id, svc({ port }));
    await expectHttp(h.publishService(sam, vm.id, svc({ port: 9999 })), 422, /at most 5/);

    // A rule added by hand in Proxmox survives the portal rewriting its own.
    await p.homelab.firewallAddRule("pve1", vmid, {
      type: "in",
      action: "ACCEPT",
      proto: "tcp",
      dport: "5000",
      comment: "by hand",
    });
    await h.removeService(sam, blog.id);
    expect(p.homelab.reachable(vmid, NETBIRD, 8080)).toBe(false);
    expect(p.homelab.reachable(vmid, NETBIRD, 5000)).toBe(true);
    expect(p.homelab.reachable(vmid, NETBIRD, 22)).toBe(true);
    const comments = p.homelab.guests.get(vmid)!.firewall!.rules.map((r) => String(r.comment));
    expect(comments.filter((c) => c === "macs:access").length).toBe(1); // rewrites do not pile up duplicates
    expect(comments.filter((c) => c.startsWith("macs:service")).length).toBe(4);
  });

  it("holds services for approval when the cluster requires it", async () => {
    p.cfg.clusters[1]!.network.service_approval = "required";
    const sam = p.who("sam");
    const admin = p.who("admin");
    const vm = await p.makeVm("sam", "homelab", "web", false);
    const blog = await h.publishService(sam, vm.id, svc({ name: "Blog" }));
    expect(blog.status).toBe("pending");
    expect(p.homelab.reachable(vm.vmid!, NETBIRD, 8080)).toBe(false);
    expect(await h.serviceDirectory(p.who("alice"))).toEqual([]);
    expect((await infra.approvals()).services.map((s) => s.id)).toEqual([blog.id]);
    await infra.reviewService(admin, blog.id, { approve: true, note: "" });
    expect(p.homelab.reachable(vm.vmid!, NETBIRD, 8080)).toBe(true);
    expect((await infra.approvals()).services).toEqual([]);

    const dbSvc = await h.publishService(sam, vm.id, svc({ name: "DB", port: 5432 }));
    await infra.reviewService(admin, dbSvc.id, { approve: false, note: "no" });
    expect(p.homelab.reachable(vm.vmid!, NETBIRD, 5432)).toBe(false);
    const status = Object.fromEntries((await h.vmDetail(sam, vm.id)).services.map((s) => [s.name, s.status]));
    expect(status).toEqual({ Blog: "published", DB: "rejected" });
  });

  it("keeps the firewall right through restore, policy changes and deletion", async () => {
    p.cfg.clusters[1]!.backup_storage = "pbs";
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "web", false);
    const vmid = vm.vmid!;
    await p.run(h.createBackup(sam, vm.id, { notes: "" }));
    const backup = (await h.vmDetail(sam, vm.id)).backups[0]!;
    // The backup predates the service; rolling back must not close the port.
    await h.publishService(sam, vm.id, svc({ name: "Blog" }));
    await p.run(h.restore(sam, vm.id, { backupId: backup.id }));
    expect(p.homelab.reachable(vmid, NETBIRD, 8080)).toBe(true);
    expect(p.homelab.reachable(vmid, NEIGHBOUR, 8080)).toBe(false);

    p.cfg.clusters[1]!.network.public_sources = ["10.99.0.1"];
    await p.run(infra.networkSync(p.who("admin"), "homelab"));
    expect(p.homelab.reachable(vmid, "10.99.0.1", 8080)).toBe(true);
    expect(p.homelab.reachable(vmid, NETBIRD, 8080)).toBe(false);
    await expectHttp(infra.networkSync(p.who("admin"), "research"), 409);

    await p.run(h.deleteVm(sam, vm.id));
    expect(await infra.allServices()).toEqual([]);
  });

  it("isolates a VM when it is adopted", async () => {
    p.homelab.seedVm(500, "old-box", "pve1", true, { net0: "virtio=AA:BB:CC:00:00:01,bridge=vmbr0" });
    expect(p.homelab.reachable(500, NEIGHBOUR, 22)).toBe(true);
    await infra.adopt(p.who("admin"), {
      clusterId: "homelab",
      vmid: 500,
      ownerId: p.who("sam").id,
      gpuAccess: false,
    });
    expect(p.homelab.reachable(500, NEIGHBOUR, 22)).toBe(false);
    expect(p.homelab.reachable(500, NETBIRD, 22)).toBe(true);
  });

  it("curates the image library", async () => {
    const admin = p.who("admin");
    const lib = async (u: string, c: string) =>
      (await h.listClusters(p.who(u))).find((x) => x.id === c)!.images.map((i) => i.id);
    expect(await lib("alice", "research")).toEqual(["jam"]);
    expect((await h.listClusters(p.who("alice")))[0]!.images[0]!.gpuReady).toBe(true);
    let listing = await infra.adminImages("homelab");
    expect(listing.images.map((i) => [i.id, i.missing])).toEqual([["ubuntu", false]]);
    expect(listing.unlisted.templates).toEqual([]);
    expect(listing.unlisted.isos.length).toBe(4);

    // Add a second template and an ISO; bogus sources are refused.
    p.homelab.seedVm(9010, "debian-12-cloud", "pve1");
    p.homelab.guests.get(9010)!.template = true;
    p.core.invalidate("homelab");
    const fields = {
      clusterId: "homelab",
      description: "",
      os: "linux" as const,
      defaultUser: "",
      cicustom: "",
      gpuReady: false,
      tags: [],
      connect: [],
      enabled: true,
      volid: "",
    };
    await expectHttp(infra.addImage(admin, { ...fields, kind: "template", name: "Nope", vmid: 1234 }), 422);
    await expectHttp(
      infra.addImage(admin, { ...fields, kind: "iso", name: "Nope", volid: "isos:iso/missing.iso" }),
      422,
    );
    const deb = await infra.addImage(admin, {
      ...fields,
      kind: "template",
      name: "Debian 12",
      vmid: 9010,
      defaultUser: "debian",
      tags: ["Minimal", "minimal "],
    });
    expect(deb).toMatchObject({ id: "debian-12", tags: ["minimal"] });
    const iso = await infra.addImage(admin, {
      ...fields,
      kind: "iso",
      name: "NixOS installer",
      os: "other",
      volid: "isos:iso/nixos-minimal-24.11-x86_64-linux.iso",
    });
    expect(await lib("sam", "homelab")).toEqual(["debian-12", "ubuntu", "nixos-installer"]); // templates before ISOs

    // Hide one: gone for users and cannot be deployed.
    await infra.editImage(admin, deb.dbId, {
      ...fields,
      name: "Debian 12",
      defaultUser: "debian",
      enabled: false,
    });
    expect(await lib("sam", "homelab")).not.toContain("debian-12");
    await expectHttp(
      h.createVm(p.who("sam"), {
        clusterId: "homelab",
        name: "x",
        imageSlug: "debian-12",
        cores: 1,
        memoryMb: 1024,
        diskGb: 10,
        sshPublicKey: KEY,
        wantsGpu: false,
        justification: "",
      }),
      422,
      /library/,
    );

    // A template deleted from Proxmox is flagged.
    p.homelab.guests.delete(9000);
    p.core.invalidate("homelab");
    listing = await infra.adminImages("homelab");
    expect(Object.fromEntries(listing.images.map((i) => [i.id, i.missing]))).toEqual({
      "debian-12": false,
      ubuntu: true,
      "nixos-installer": false,
    });

    await infra.deleteImage(admin, iso.dbId);
    expect(await lib("sam", "homelab")).toEqual(["ubuntu"]);
  });

  it("deploys from an ISO", async () => {
    const iso = await infra.addImage(p.who("admin"), {
      clusterId: "homelab",
      kind: "iso",
      name: "Debian installer",
      os: "linux",
      volid: "isos:iso/debian-12.8.0-amd64-netinst.iso",
      description: "",
      defaultUser: "",
      cicustom: "",
      gpuReady: false,
      tags: [],
      connect: [],
      enabled: true,
    });
    const vm = await p.run(
      h.createVm(p.who("sam"), {
        clusterId: "homelab",
        name: "from-iso",
        imageSlug: iso.id,
        cores: 2,
        memoryMb: 2048,
        diskGb: 20,
        sshPublicKey: "",
        wantsGpu: false,
        justification: "",
      }),
    );
    const detail = await h.vmDetail(p.who("sam"), vm.id);
    expect(detail).toMatchObject({ status: "active", power: "running", image: { kind: "iso" } });
    expect(detail.jobs[0]!.log).toContain("console");
    const config = p.homelab.guests.get(detail.vmid!)!.config;
    expect(config).toMatchObject({
      ide2: "isos:iso/debian-12.8.0-amd64-netinst.iso,media=cdrom",
      machine: "q35",
      bios: "ovmf",
      boot: "order=scsi0;ide2",
      tags: "macs;owner-sam",
    });
    expect(String(config.scsi0)).toContain("size=20G");
    expect(config.sshkeys).toBeUndefined();
    expect(p.homelab.reachable(detail.vmid!, NEIGHBOUR, 22)).toBe(false); // isolated like any other homelab VM
  });

  it("summarises clusters and people for infrastructure", async () => {
    await p.makeVm("alice", "research", "a");
    const lab = await p.makeVm("sam", "homelab", "lab", false);
    await h.publishService(p.who("sam"), lab.id, svc({ name: "Blog" }));
    p.research.seedVm(500, "legacy", "pve2", true, { hostpci0: "mapping=rtx4090,pcie=1" });
    p.core.invalidate("research");
    await h.createVm(p.who("bob"), {
      clusterId: "research",
      name: "wait",
      imageSlug: "jam",
      cores: 2,
      memoryMb: 2048,
      diskGb: 30,
      sshPublicKey: KEY,
      wantsGpu: false,
      justification: "x",
    });
    const [research, homelab] = await infra.overview();
    expect(research!.vms).toEqual({ managed: 1, owners: 1, archived: 0, running: 1, unmanaged: 1 });
    expect(research!.gpus).toEqual({ total: 2, inUse: 1, booked: 0, upcoming: 0 });
    expect(research!.pending).toEqual({ vms: 1, gpu: 0, services: 0 });
    expect(research!.allocated.cores).toBe(2);
    expect(research!.network.firewallOk).toBeNull();
    expect(homelab!.gpus).toBeNull();
    expect(homelab!.network).toMatchObject({ published: 1, firewallOk: true });

    p.homelab.datacenterFirewall = false;
    p.core.invalidate("homelab");
    expect((await infra.overview())[1]!.network.firewallOk).toBe(false);

    const sam = (await infra.people()).find((x) => x.name === "sam")!;
    expect(sam).toMatchObject({ vms: 1, cores: 2, isAdmin: false });
    expect((await infra.auditLog(50)).map((a) => a.action)).toEqual(
      expect.arrayContaining(["publish-service", "request-vm", "provision"]),
    );
    expect(await db.audit.count()).toBeGreaterThan(3);
  });
});
