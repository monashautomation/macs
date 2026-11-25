import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { resetEnvForTests } from "@/env";
import { db } from "@/lib/db";
import { startConsoleServer } from "@/server/console-server";
import * as infra from "@/server/handlers/infra";
import * as m from "@/server/handlers/manage";
import * as h from "@/server/handlers/vms";
import { idlePass, localClock } from "@/server/services/housekeeping";
import { labSecret } from "@/server/services/labs";
import { expectHttp, hasDb, KEY, NEIGHBOUR, NETBIRD, Portal } from "./portal";

describe.skipIf(!hasDb)("student tools", () => {
  let p: Portal;
  beforeEach(async () => {
    p = await Portal.create();
  });
  const notes = async (name: string) => (await m.listNotifications(p.who(name))).items.map((n) => n.kind);

  it("takes snapshots, rolls back to them and enforces the limit", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "snap", false);
    await p.run(m.createSnapshot(sam, vm.id, { name: "clean", description: "fresh install" }));
    await expectHttp(m.createSnapshot(sam, vm.id, { name: "clean", description: "" }), 409, /already has/);
    await p.run(m.createSnapshot(sam, vm.id, { name: "second", description: "" }));
    await expectHttp(m.createSnapshot(sam, vm.id, { name: "third", description: "" }), 422, /keep 2/);
    expect((await m.listSnapshots(sam, vm.id)).snapshots.map((s) => s.name)).toEqual(["second", "clean"]);

    await expectHttp(m.rollback(sam, vm.id, "nope"), 404);
    await p.run(m.rollback(sam, vm.id, "clean"));
    const guest = p.homelab.guests.get(vm.vmid!)!;
    expect(guest.generation).toBe(1);
    expect(guest.status).toBe("running"); // it was running, so it is started again
    expect(p.homelab.reachable(vm.vmid!, NEIGHBOUR, 22)).toBe(false); // still isolated

    await p.run(m.deleteSnapshot(sam, vm.id, "second"));
    expect((await m.listSnapshots(sam, vm.id)).snapshots).toHaveLength(1);
    await expectHttp(m.createSnapshot(p.who("bob"), vm.id, { name: "x1", description: "" }), 404);
  });

  it("rebuilds a VM in place with a new one-time password", async () => {
    const sam = p.who("sam");
    const first = await p.run(
      h.quickDeploy(sam, { clusterId: "homelab", setupSlug: "nginx", imageSlug: "" }),
    );
    const before = await h.vmDetail(sam, first.id);
    expect(before.services).toHaveLength(1);
    await p.run(m.createSnapshot(sam, first.id, { name: "old", description: "" }));

    const again = await p.run(m.rebuild(sam, first.id));
    expect(again.login?.password).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/);
    expect(again.login?.password).not.toBe(first.login?.password);
    const after = await h.vmDetail(sam, first.id);
    expect(after).toMatchObject({ status: "active", vmid: before.vmid, name: before.name });
    expect(after.setup?.status).toBe("done");
    expect(after.services).toHaveLength(1); // published port survives
    expect(p.homelab.reachable(after.vmid!, NETBIRD, 80)).toBe(true);
    const guest = p.homelab.guests.get(after.vmid!)!;
    expect(guest.config.cipassword).toBe(again.login?.password);
    expect(guest.snapshots ?? []).toHaveLength(0); // a new disk
    expect(p.homelab.guestRuns.filter((r) => r.vmid === after.vmid)).toHaveLength(2); // setup ran again
    // The password is nowhere it could be read back from.
    const stored = JSON.stringify([
      await db.job.findMany(),
      await db.audit.findMany(),
      await db.vm.findMany(),
    ]);
    expect(stored).not.toContain(again.login!.password);
    await expectHttp(m.rebuild(p.who("bob"), first.id), 404);
  });

  it("resizes within limits and quota, restarting only when it must", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "grow", false);
    const size = { cores: 2, memoryMb: 2048, diskGb: 30 };
    await expectHttp(m.resize(sam, vm.id, size), 422, /already/);
    await expectHttp(m.resize(sam, vm.id, { ...size, diskGb: 20 }), 422, /shrink/);
    await expectHttp(m.resize(sam, vm.id, { ...size, cores: 8 }), 422, /per-VM limit/);
    await p.makeVm("sam", "homelab", "other", false);
    await expectHttp(m.resize(sam, vm.id, { ...size, cores: 3 }), 422, /quota/); // 3 + 2 > 4 cores

    const guest = p.homelab.guests.get(vm.vmid!)!;
    const started = guest.started;
    await p.run(m.resize(sam, vm.id, { ...size, diskGb: 40 })); // disk only: no restart
    expect(guest.started).toBe(started);
    expect(String(guest.config.scsi0)).toContain("size=40G");

    await new Promise((r) => setTimeout(r, 5));
    await p.run(m.resize(sam, vm.id, { cores: 1, memoryMb: 4096, diskGb: 40 }));
    expect(guest.config).toMatchObject({ cores: 1, memory: 4096 });
    expect(guest.status).toBe("running");
    expect(guest.started).toBeGreaterThan(started);
    expect(await h.vmDetail(sam, vm.id)).toMatchObject({ cores: 1, memoryMb: 4096, diskGb: 40 });

    // Approved VMs are resized by infrastructure.
    const research = await p.makeVm("alice", "research", "sized", false);
    await expectHttp(m.resize(p.who("alice"), research.id, { ...size, cores: 4 }), 403);
    await p.run(m.resize(p.who("admin"), research.id, { ...size, cores: 4 }));
    expect(p.research.guests.get(research.vmid!)!.config.cores).toBe(4);
  });

  it("warns before a VM expires, shuts it down, and lets it be extended", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "old", false);
    expect(new Date(vm.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    await p.tick();
    expect(await notes("sam")).not.toContain("vm.expiring");

    await db.vm.update({ where: { id: vm.id }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });
    await p.tick();
    await p.tick();
    expect((await notes("sam")).filter((k) => k === "vm.expiring")).toHaveLength(1); // warned once

    await db.vm.update({ where: { id: vm.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await p.tick();
    expect(p.homelab.guests.get(vm.vmid!)!.status).toBe("stopped");
    expect(await h.vmDetail(sam, vm.id)).toMatchObject({ status: "active", expired: true });
    expect(await notes("sam")).toContain("vm.expired");
    await expectHttp(h.powerVm(sam, vm.id, "start"), 409, /expired/);

    await m.extend(sam, vm.id);
    await p.run(h.powerVm(sam, vm.id, "start"));
    expect(p.homelab.guests.get(vm.vmid!)!.status).toBe("running");
    await p.tick();
    expect(p.homelab.guests.get(vm.vmid!)!.status).toBe("running");
    // Research VMs do not expire.
    const research = await p.makeVm("alice", "research", "keep", false);
    expect(research.expiresAt).toBeNull();
    await expectHttp(m.extend(p.who("alice"), research.id), 409);
  });

  it("stops and starts VMs on their daily schedule, once a day", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "nightly", false);
    const guest = p.homelab.guests.get(vm.vmid!)!;
    await expectHttp(m.setSchedule(sam, vm.id, { start: "", stop: "01:00", timeZone: "Mars/Olympus" }), 422);
    await m.setSchedule(sam, vm.id, { start: "", stop: "00:00", timeZone: "Australia/Melbourne" });
    await p.tick();
    expect(guest.status).toBe("running"); // 00:00 already passed when it was set: first fires tomorrow

    await db.vm.update({ where: { id: vm.id }, data: { lastAutoStop: "2000-01-01" } }); // "tomorrow"
    await p.tick();
    expect(guest.status).toBe("stopped");
    await p.run(h.powerVm(sam, vm.id, "start"));
    await p.tick();
    expect(guest.status).toBe("running"); // not stopped a second time the same day

    await p.run(h.powerVm(sam, vm.id, "stop"));
    await db.vm.update({
      where: { id: vm.id },
      data: { autoStop: "", autoStart: "00:00", lastAutoStart: "" },
    });
    await p.tick();
    expect(guest.status).toBe("running");
    const row = await db.vm.findUniqueOrThrow({ where: { id: vm.id } });
    expect(row.lastAutoStart).toBe(localClock(new Date(), "Australia/Melbourne").date);
  });

  it("keeps a weekday-only schedule off the other days", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "weekdays", false);
    const guest = p.homelab.guests.get(vm.vmid!)!;
    const today = localClock(new Date(), "UTC").weekday;
    expect(today).toBeGreaterThanOrEqual(1);
    expect(localClock(new Date("2026-11-25T12:00:00Z"), "UTC").weekday).toBe(3); // a Wednesday
    expect(localClock(new Date("2026-11-29T20:00:00Z"), "Australia/Melbourne").weekday).toBe(1); // Monday there
    const others = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today);
    await m.setSchedule(sam, vm.id, { stop: "00:00", timeZone: "UTC", days: others });
    await db.vm.update({ where: { id: vm.id }, data: { lastAutoStop: "" } });
    await p.tick();
    expect(guest.status).toBe("running"); // today is not one of its days
    expect((await h.vmDetail(sam, vm.id)).schedule.days).toEqual(others);

    await m.setSchedule(sam, vm.id, { stop: "00:00", timeZone: "UTC", days: [today] });
    await db.vm.update({ where: { id: vm.id }, data: { lastAutoStop: "" } });
    await p.tick();
    expect(guest.status).toBe("stopped");
    await m.setSchedule(sam, vm.id, { stop: "00:00", timeZone: "UTC", days: [1, 2, 3, 4, 5, 6, 7] });
    expect((await h.vmDetail(sam, vm.id)).schedule.days).toEqual([]); // all seven = every day
  });

  it("warns about idle VMs, shuts them down after the grace period, and can be told to leave one alone", async () => {
    const sam = p.who("sam");
    const idle = await p.makeVm("sam", "homelab", "sleepy", false);
    const busy = await p.makeVm("sam", "homelab", "worker", false);
    const now = new Date();
    p.homelab.idleVms.add(idle.vmid!);
    await idlePass(p.core, now, true);
    expect(await notes("sam")).not.toContain("vm.idle"); // only just started: not enough history
    for (const v of [idle, busy]) p.homelab.guests.get(v.vmid!)!.started = Date.now() - 5 * 86_400_000;

    await idlePass(p.core, now, true);
    await idlePass(p.core, now, true);
    expect((await notes("sam")).filter((k) => k === "vm.idle")).toHaveLength(1);
    expect((await h.vmDetail(sam, idle.id)).idleSince).not.toBeNull();
    expect((await h.vmDetail(sam, busy.id)).idleSince).toBeNull();

    // "Keep running" clears the warning and holds off further checks.
    await m.keepRunning(sam, idle.id);
    await idlePass(p.core, now, true);
    expect((await h.vmDetail(sam, idle.id)).idleSince).toBeNull();

    // Once that lapses: warned again, then shut down a grace period later.
    await db.vm.update({ where: { id: idle.id }, data: { idleCheckAfter: new Date(now.getTime() - 1000) } });
    await idlePass(p.core, now, true);
    await idlePass(p.core, now, true);
    expect(p.homelab.guests.get(idle.vmid!)!.status).toBe("running"); // still inside the grace period
    await db.vm.update({
      where: { id: idle.id },
      data: { idleWarnedAt: new Date(now.getTime() - 1.1 * 86_400_000) },
    });
    await idlePass(p.core, now, true);
    expect(p.homelab.guests.get(idle.vmid!)!.status).toBe("stopped");
    expect(p.homelab.guests.get(busy.vmid!)!.status).toBe("running");
    expect((await notes("sam")).filter((k) => k === "vm.idle")).toHaveLength(2);
    expect(await notes("sam")).toContain("vm.idle-stopped");
    await p.run(h.powerVm(sam, idle.id, "start")); // nothing stops them starting it again
    expect((await h.vmDetail(sam, idle.id)).idleSince).toBeNull();

    // A VM that picks up work again is un-flagged.
    p.homelab.guests.get(idle.vmid!)!.started = Date.now() - 5 * 86_400_000;
    await idlePass(p.core, now, true);
    expect((await h.vmDetail(sam, idle.id)).idleSince).not.toBeNull();
    p.homelab.idleVms.delete(idle.vmid!);
    await idlePass(p.core, now, true);
    expect((await h.vmDetail(sam, idle.id)).idleSince).toBeNull();
  });

  it("shares a VM for use without handing over ownership", async () => {
    const [sam, bob, alice] = [p.who("sam"), p.who("bob"), p.who("alice")];
    const vm = await p.makeVm("sam", "homelab", "team", false);
    await expectHttp(h.vmDetail(bob, vm.id), 404);
    expect(await m.findPeople(sam, "bo")).toEqual([{ id: bob.id, name: "bob", image: null }]);
    await expectHttp(m.addShare(bob, vm.id, { userId: bob.id }), 404); // cannot share someone else's VM
    await m.addShare(sam, vm.id, { userId: bob.id });
    expect(await notes("bob")).toEqual(["vm.shared"]);

    const seen = await h.vmDetail(bob, vm.id);
    expect(seen).toMatchObject({ access: "shared", name: "team" });
    expect((await h.vmDetail(sam, vm.id)).sharedWith.map((u) => u.name)).toEqual(["bob"]);
    expect((await h.listVms(bob, "mine")).map((v) => [v.name, v.access])).toEqual([["team", "shared"]]);
    await p.run(h.powerVm(bob, vm.id, "reboot"));
    expect((await h.openConsole(bob, vm.id)).name).toBe("team");
    await m.extend(bob, vm.id);
    // ...but nothing that changes or exposes the VM itself.
    for (const attempt of [
      () => h.deleteVm(bob, vm.id),
      () => m.rebuild(bob, vm.id),
      () => m.resetPassword(bob, vm.id),
      () => m.resize(bob, vm.id, { cores: 1, memoryMb: 1024, diskGb: 30 }),
      () => m.addShare(bob, vm.id, { userId: alice.id }),
      () => m.setSchedule(bob, vm.id, { start: "", stop: "01:00", timeZone: "UTC" }),
      () =>
        h.publishService(bob, vm.id, { name: "x", description: "", port: 8080, protocol: "tcp", scheme: "" }),
    ]) {
      await expectHttp(attempt(), 404);
    }
    await expectHttp(m.removeShare(alice, vm.id, bob.id), 404);
    await m.removeShare(bob, vm.id, bob.id); // leaving is allowed
    await expectHttp(h.vmDetail(bob, vm.id), 404);
  });

  it("adds SSH keys and resets the password without leaking either into a shell or a log", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "login", false);
    await db.image.updateMany({ where: { clusterId: "homelab" }, data: { defaultUser: "ubuntu" } });
    const second = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsecondkeysecondkeysecondkeysecondkey00 laptop two";
    await expectHttp(m.installKeys(sam, vm.id, { sshPublicKey: "ssh-ed25519 $(reboot)" }), 422);
    await expectHttp(m.installKeys(sam, vm.id, { sshPublicKey: `${second}\nMACS_KEYS\nrm -rf /` }), 422);
    await p.run(m.installKeys(sam, vm.id, { sshPublicKey: `${second}; touch /tmp/pwned` }));
    const run = p.homelab.guestRuns.at(-1)!;
    expect(run.script).toContain("U='ubuntu'");
    expect(run.script).toContain(
      `${second.split(" ").slice(0, 2).join(" ")} laptop-two-touch-tmppwned\nMACS_KEYS`,
    );
    expect(run.script).not.toContain("; touch");
    const row = await db.vm.findUniqueOrThrow({ where: { id: vm.id } });
    expect(row.sshPublicKey.split("\n")).toHaveLength(2); // kept for a rebuild
    expect(row.sshPublicKey).toContain(KEY);

    const { login } = await m.resetPassword(sam, vm.id);
    expect(p.homelab.guestPasswords.get(vm.vmid!)).toEqual({ username: "ubuntu", password: login.password });
    const stored = JSON.stringify([
      await db.job.findMany(),
      await db.audit.findMany(),
      await db.vm.findMany(),
    ]);
    expect(stored).not.toContain(login.password);
    expect((await db.audit.findMany({ where: { action: "reset-password" } }))[0]?.detail).toBe(
      "account ubuntu",
    );

    p.homelab.noAgent.add(vm.vmid!);
    await expect(m.resetPassword(sam, vm.id)).rejects.toThrow(/guest agent/);
    await p.run(h.powerVm(sam, vm.id, "stop"));
    await expectHttp(m.resetPassword(sam, vm.id), 409, /start the VM/);
    expect((await m.saveProfile(sam, { sshPublicKey: `${KEY}\n${KEY}` })).sshPublicKey).toBe(KEY);
  });

  describe("terminal", () => {
    const ORIGIN = "http://localhost:3000";
    let wss: ReturnType<typeof startConsoleServer>;
    beforeEach(async () => {
      wss = startConsoleServer(p.core, 0, ORIGIN);
      await new Promise((r) => wss.once("listening", r));
    });
    afterEach(() => new Promise<void>((r) => wss.close(() => r())));

    it("relays a serial terminal, with resizes, to people who can use the VM", async () => {
      const sam = p.who("sam");
      const vm = await p.makeVm("sam", "homelab", "shell", false);
      await expectHttp(m.openTerminal(p.who("bob"), vm.id), 404);
      const grant = await m.openTerminal(sam, vm.id);
      const ws = new WebSocket(
        `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/console-ws/${grant.token}`,
        ["binary"],
      );
      ws.on("error", () => {});
      let text = "";
      ws.on("message", (d) => {
        text += String(d);
      });
      const until = async (want: string) => {
        for (let i = 0; i < 200 && !text.includes(want); i++) await new Promise((r) => setTimeout(r, 10));
        expect(text).toContain(want);
      };
      // The origin header is what a browser would send.
      await new Promise((r) => ws.once("close", r));
      const ok = new WebSocket(
        `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/console-ws/${(await m.openTerminal(sam, vm.id)).token}`,
        ["binary"],
        { origin: ORIGIN },
      );
      ok.on("message", (d) => {
        text += String(d);
      });
      await new Promise((r) => ok.once("open", r));
      await until("shell (mock serial terminal)");
      ok.send(Buffer.from("uptime\r"));
      await until("mock shell: uptime");
      ok.send(JSON.stringify({ resize: [132, 43] }));
      const term = p.homelab.terminals.at(-1)!;
      for (let i = 0; i < 100 && term.size[0] !== 132; i++) await new Promise((r) => setTimeout(r, 10));
      expect(term.size).toEqual([132, 43]);
      ok.close();
      for (let i = 0; i < 100 && !term.closed; i++) await new Promise((r) => setTimeout(r, 10));
      expect(term.closed).toBe(true);

      // A VM from before terminals existed gets the port, and is told to restart.
      delete p.homelab.guests.get(vm.vmid!)!.config.serial0;
      await expectHttp(m.openTerminal(sam, vm.id), 409, /switched on/);
      expect(p.homelab.guests.get(vm.vmid!)!.config.serial0).toBe("socket");
    });
  });

  it("deploys a lab whose VMs reach each other and nobody else", async () => {
    const sam = p.who("sam");
    await expectHttp(
      m.createLab(sam, { clusterId: "homelab", blueprint: "k3s-cluster", name: "k" }),
      422,
      /quota/,
    );
    await expectHttp(
      m.createLab(p.who("alice"), { clusterId: "research", blueprint: "pair", name: "x" }),
      422,
    );
    const lab = await p.run(m.createLab(sam, { clusterId: "homelab", blueprint: "pair", name: "duo" }));
    expect(lab.vms.map((v) => v.name)).toEqual(["duo-a", "duo-b"]);
    const [a, b] = await Promise.all(lab.vms.map((v) => h.vmDetail(sam, v.id)));
    expect(a).toMatchObject({ status: "active", power: "running", lab: { name: "duo", role: "a" } });
    expect(a!.lab!.steps[1]).toBe("From it, run: ping duo-b");
    for (const v of [a!, b!]) {
      expect(p.homelab.guests.get(v.vmid!)!.config.cipassword).toBe(lab.login.password);
    }
    const ip = (vmid: number) => `10.20.${Math.floor(vmid / 256)}.${vmid % 256}`;
    expect(p.homelab.reachable(a!.vmid!, ip(b!.vmid!), 5432)).toBe(true);
    expect(p.homelab.reachable(b!.vmid!, ip(a!.vmid!), 22)).toBe(true);
    expect(p.homelab.reachable(a!.vmid!, NEIGHBOUR, 5432)).toBe(false);
    const script = p.homelab.guestRuns.find((r) => r.vmid === a!.vmid)!.script;
    expect(script).toContain(`${ip(b!.vmid!)} duo-b # macs-lab`);
    expect(script).toContain(`LAB_SECRET='${labSecret(lab.id)}'`);
    expect(JSON.stringify(await db.job.findMany())).not.toContain(labSecret(lab.id));
    expect(await notes("sam")).toContain("lab.ready");
    expect(await m.listLabs(sam)).toMatchObject([{ id: lab.id, name: "duo", blueprint: "Two servers" }]);

    await expectHttp(m.deleteLab(p.who("bob"), lab.id), 404);
    await p.run(m.deleteLab(sam, lab.id));
    expect(await m.listLabs(sam)).toEqual([]);
    expect(p.homelab.guests.has(a!.vmid!)).toBe(false);
  });

  it("notifies people in the app and through the webhook, retrying until it is accepted", async () => {
    const alice = p.who("alice");
    const sub = "authentik-sub-123";
    await db.account.create({ data: { userId: alice.id, providerId: "authentik", accountId: sub } });
    const calls: { auth: string | null; body: Record<string, unknown> }[] = [];
    let up = false;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push({
        auth: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)),
      });
      return new Response(null, { status: up ? 204 : 503 });
    });
    process.env.NOTIFY_WEBHOOK_URL = "http://bot.test/hooks/macs";
    process.env.NOTIFY_WEBHOOK_TOKEN = "t0ken";
    resetEnvForTests();
    try {
      const vm = await h.createVm(alice, {
        clusterId: "research",
        name: "nope",
        imageSlug: "jam",
        cores: 2,
        memoryMb: 2048,
        diskGb: 30,
        sshPublicKey: KEY,
        justification: "thesis",
      });
      await infra.reviewVm(p.who("admin"), vm.id, {
        approve: false,
        grantGpu: false,
        note: "ask again in March",
      });
      const inbox = await m.listNotifications(alice);
      expect(inbox).toMatchObject({
        unread: 1,
        items: [{ kind: "vm.rejected", body: "ask again in March" }],
      });
      expect((await h.session(alice)).unread).toBe(1);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      up = true;
      await p.tick(); // the scheduler retries what the webhook refused
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual({
        auth: "Bearer t0ken",
        body: {
          id: inbox.items[0]!.id,
          kind: "vm.rejected",
          title: "Your request for nope was declined",
          body: "ask again in March",
          url: `http://localhost:3000/vms/${vm.id}`,
          user: { sub, name: "alice" },
          createdAt: inbox.items[0]!.createdAt,
        },
      });
      expect(JSON.stringify(calls)).not.toContain("example.test"); // no email
      await p.tick();
      expect(calls).toHaveLength(2); // delivered once
      await m.markNotificationsRead(alice);
      expect((await m.listNotifications(alice)).unread).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.NOTIFY_WEBHOOK_URL;
      delete process.env.NOTIFY_WEBHOOK_TOKEN;
      resetEnvForTests();
    }
  });
});
