import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import * as infra from "@/server/handlers/infra";
import * as h from "@/server/handlers/vms";
import { BUILTIN, generatePassword } from "@/server/services/setups";
import { expectHttp, hasDb, KEY, NEIGHBOUR, NETBIRD, Portal } from "./portal";

describe("setup recipes", () => {
  it("built-ins are well formed", () => {
    expect(new Set(BUILTIN.map((b) => b.slug)).size).toBe(BUILTIN.length);
    for (const b of BUILTIN) {
      expect(b.script.trim().length, b.slug).toBeGreaterThan(10);
      expect(
        b.ports.every((p) => p.port !== 22),
        `${b.slug} must not claim the login port`,
      ).toBe(true);
    }
  });

  it("generates passwords people can type", () => {
    const a = generatePassword();
    expect(a).toMatch(/^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){3}$/);
    expect(generatePassword()).not.toBe(a);
  });
});

describe.skipIf(!hasDb)("one-click installs", () => {
  let p: Portal;
  beforeEach(async () => {
    p = await Portal.create();
  });

  it("offers setups only where the cluster enables them", async () => {
    const [research, homelab] = await h.listClusters(p.who("alice"));
    expect(research!.setups).toEqual([]);
    expect(homelab!.setups.map((s) => s.id)).toContain("gitea");
    expect(homelab!.defaultImage).toBe("ubuntu");
    await expectHttp(
      h.quickDeploy(p.who("alice"), { clusterId: "research", setupSlug: "", imageSlug: "" }),
      422,
      /request/,
    );
  });

  it("deploys a setup in one call: name, size, login, network, install and ports", async () => {
    const sam = p.who("sam");
    const created = await p.run(
      h.quickDeploy(sam, { clusterId: "homelab", setupSlug: "gitea", imageSlug: "" }),
    );
    expect(created).toMatchObject({
      name: "gitea",
      cores: 2,
      memoryMb: 2048,
      diskGb: 40,
      imageSlug: "ubuntu",
      setupSlug: "gitea",
    });
    // Login is set up for them and shown exactly once.
    expect(created.login).toMatchObject({ user: "ubuntu" });
    expect(created.login!.password).toMatch(/^[a-z2-9-]{19}$/);

    const vm = await h.vmDetail(sam, created.id);
    expect(vm).toMatchObject({ status: "active", power: "running", setupStatus: "done" });
    expect(vm.setup).toMatchObject({ name: "Gitea", status: "done" });
    expect(vm).not.toHaveProperty("login");
    const guest = p.homelab.guests.get(vm.vmid!)!;
    expect(guest.config).toMatchObject({
      ciuser: "ubuntu",
      ipconfig0: "ip=dhcp",
      cipassword: created.login!.password,
    });
    expect(guest.config.sshkeys).toBeUndefined(); // sam has no saved key yet: password only
    // Nothing recoverable is left in the database or the logs.
    const dump = JSON.stringify([await db.vm.findMany(), await db.job.findMany(), await db.audit.findMany()]);
    expect(dump).not.toContain(created.login!.password);

    // The recipe ran inside the VM, after the VM was configured.
    const run = p.homelab.guestRuns.at(-1)!;
    expect(run.vmid).toBe(vm.vmid);
    expect(run.script).toContain("gitea/gitea");
    expect(run.script).toContain("MACS_USER='ubuntu'");
    expect(run.script).toContain("MACS_HOSTNAME='gitea'");
    expect(vm.jobs[0]!.log).toContain("Gitea installed");

    // Its ports were published; everything else stays closed.
    expect(vm.services.map((s) => [s.name, s.port, s.status])).toEqual([
      ["Gitea", 3000, "published"],
      ["Gitea SSH", 2222, "published"],
    ]);
    expect(p.homelab.reachable(vm.vmid!, NETBIRD, 3000)).toBe(true);
    expect(p.homelab.reachable(vm.vmid!, NEIGHBOUR, 3000)).toBe(false);
    expect(p.homelab.reachable(vm.vmid!, NETBIRD, 8080)).toBe(false);

    // A second one gets its own name.
    const again = await p.run(
      h.quickDeploy(sam, { clusterId: "homelab", setupSlug: "nginx", imageSlug: "" }),
    );
    expect(again.name).toBe("nginx");
    await expectHttp(
      h.quickDeploy(sam, { clusterId: "homelab", setupSlug: "nginx", imageSlug: "" }),
      422,
      /quota/,
    ); // max 2 VMs
  });

  it("uses the saved SSH key, and a plain OS needs no setup", async () => {
    const sam = p.who("sam");
    await db.profile.create({ data: { userId: sam.id, sshPublicKey: KEY } });
    const created = await p.run(
      h.quickDeploy(sam, { clusterId: "homelab", setupSlug: "", imageSlug: "ubuntu" }),
    );
    expect(created).toMatchObject({ name: "ubuntu", setupSlug: "", setupStatus: "none" });
    const config = p.homelab.guests.get((await h.vmDetail(sam, created.id)).vmid!)!.config;
    expect(String(config.sshkeys)).toMatch(/^ssh-ed25519/);
    expect(config.cipassword).toBe(created.login!.password);
    expect(p.homelab.guestRuns).toEqual([]);
  });

  it("keeps the VM when a setup fails, and can retry", async () => {
    const sam = p.who("sam");
    p.homelab.failScriptsContaining = "nginx";
    const created = await p.run(
      h.quickDeploy(sam, { clusterId: "homelab", setupSlug: "nginx", imageSlug: "" }),
    );
    let vm = await h.vmDetail(sam, created.id);
    expect(vm).toMatchObject({ status: "active", power: "running", setupStatus: "failed" });
    expect(vm.jobs[0]).toMatchObject({ status: "failed" });
    expect(vm.jobs[0]!.log).toContain("Unable to locate package");
    expect(vm.services).toEqual([]); // nothing published for something that is not running

    await expectHttp(h.retrySetup(p.who("alice"), vm.id), 404);
    p.homelab.failScriptsContaining = "";
    await p.run(h.retrySetup(sam, vm.id));
    vm = await h.vmDetail(sam, vm.id);
    expect(vm.setupStatus).toBe("done");
    await expectHttp(h.retrySetup(sam, vm.id), 409);
  });

  it("reports a missing guest agent clearly", async () => {
    const sam = p.who("sam");
    p.homelab.noAgent.add(1000);
    const created = await p.run(
      h.quickDeploy(sam, { clusterId: "homelab", setupSlug: "docker", imageSlug: "" }),
    );
    const vm = await h.vmDetail(sam, created.id);
    expect(vm.setupStatus).toBe("failed");
    expect(vm.jobs[0]!.error).toMatch(/guest agent/);
  });

  it("validates setups on the full form and keeps manual installs manual", async () => {
    const sam = p.who("sam");
    const base = {
      clusterId: "homelab",
      name: "x",
      imageSlug: "ubuntu",
      cores: 2,
      memoryMb: 2048,
      diskGb: 40,
      sshPublicKey: KEY,
      wantsGpu: false,
      justification: "",
    };
    await expectHttp(h.createVm(sam, { ...base, setupSlug: "nope" }), 422, /not available/);
    await expectHttp(h.createVm(sam, { ...base, setupSlug: "jellyfin" }), 422, /at least 2 vCPU, 4 GB/);
    await expectHttp(
      h.createVm(p.who("alice"), {
        ...base,
        clusterId: "research",
        imageSlug: "jam",
        justification: "x",
        setupSlug: "docker",
      }),
      422,
      /not available/,
    );
    // An installer ISO: no setup, no generated login, the person does it all.
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
    await expectHttp(
      h.createVm(sam, { ...base, imageSlug: iso.id, setupSlug: "docker" }),
      422,
      /prepared Linux image/,
    );
    await expectHttp(
      h.quickDeploy(sam, { clusterId: "homelab", setupSlug: "", imageSlug: iso.id }),
      422,
      /by hand/,
    );
    const manual = await p.run(
      h.createVm(sam, { ...base, name: "manual", imageSlug: iso.id, autoLogin: true }),
    );
    expect(manual.login).toBeNull();
    expect(p.homelab.guests.get((await h.vmDetail(sam, manual.id)).vmid!)!.config.cipassword).toBeUndefined();
  });

  it("lets only infrastructure manage the setup library", async () => {
    const admin = p.who("admin");
    const body = {
      name: "Hello",
      description: "",
      category: "Web",
      script: "echo hello",
      cores: 1,
      memoryMb: 1024,
      diskGb: 20,
      ports: [{ name: "Hello", port: 8080, protocol: "tcp" as const, scheme: "http" as const }],
      afterInstall: "",
      steps: [],
      enabled: true,
    };
    const made = await infra.addSetup(admin, body);
    expect(made).toMatchObject({ id: "hello", script: "echo hello" });
    // Members see the setup but never its script.
    const mine = (await h.listClusters(p.who("sam")))[0]!.setups.find((s) => s.id === "hello")!;
    expect(mine).not.toHaveProperty("script");
    await infra.editSetup(admin, made.dbId, { ...body, enabled: false });
    expect((await h.listClusters(p.who("sam")))[0]!.setups.some((s) => s.id === "hello")).toBe(false);
    await expectHttp(
      h.quickDeploy(p.who("sam"), { clusterId: "homelab", setupSlug: "hello", imageSlug: "" }),
      422,
    );
    expect((await infra.auditLog(10)).map((a) => a.action)).toEqual(
      expect.arrayContaining(["add-setup", "edit-setup"]),
    );
    await infra.deleteSetup(admin, made.dbId);
    expect((await infra.adminSetups()).some((s) => s.id === "hello")).toBe(false);
  });
});
