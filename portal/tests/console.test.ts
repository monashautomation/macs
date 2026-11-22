import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { type WebSocketServer } from "ws";
import { startConsoleServer } from "@/server/console-server";
import * as h from "@/server/handlers/vms";
import { expectHttp, hasDb, Portal } from "./portal";

const ORIGIN = "http://localhost:3000";

/** Collects binary frames so the test can await them one at a time. */
function client(url: string, origin = ORIGIN) {
  const ws = new WebSocket(url, ["binary"], { origin });
  const frames: Buffer[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (d) => {
    frames.push(d as Buffer);
    wake?.();
  });
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  ws.on("error", () => {});
  return {
    ws,
    closed,
    opened: new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("unexpected-response", () => reject(new Error("refused")));
    }),
    async next(): Promise<Buffer> {
      while (!frames.length) await new Promise<void>((r) => (wake = r));
      return frames.shift()!;
    },
  };
}

describe.skipIf(!hasDb)("VM console", () => {
  let p: Portal;
  let wss: WebSocketServer;
  let base: string;
  beforeEach(async () => {
    p = await Portal.create();
    wss = startConsoleServer(p.core, 0, ORIGIN);
    await new Promise((r) => wss.once("listening", r));
    base = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/console-ws`;
  });
  afterEach(() => new Promise<void>((r) => wss.close(() => r())));

  it("relays the VM screen and keystrokes both ways", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "lab", false);
    const grant = await h.openConsole(sam, vm.id);
    expect(grant).toMatchObject({ password: "mock", name: "lab" });
    const c = client(`${base}/${grant.token}`);
    await c.opened;
    expect(c.ws.protocol).toBe("binary");
    expect((await c.next()).toString()).toBe("RFB 003.008\n"); // sent before we connected, so it was buffered
    c.ws.send(Buffer.from("RFB 003.008\n"));
    expect([...(await c.next())]).toEqual([1, 1]);
    c.ws.send(Buffer.from([1]));
    expect((await c.next()).readUInt32BE(0)).toBe(0);
    c.ws.send(Buffer.from([1]));
    const init = await c.next();
    expect([init.readUInt16BE(0), init.readUInt16BE(2)]).toEqual([800, 450]);
    expect(init.toString().endsWith("lab (mock console)")).toBe(true);

    const request = (incremental: number) => {
      const b = Buffer.alloc(10);
      b.set([3, incremental]);
      b.writeUInt16BE(800, 6);
      b.writeUInt16BE(450, 8);
      return b;
    };
    c.ws.send(request(0));
    const frame = await c.next();
    expect(frame.readUInt16BE(2)).toBe(4);
    expect(frame.length).toBeGreaterThan(800 * 450 * 4);
    c.ws.send(request(1)); // nothing changed: the server holds the request open
    const key = Buffer.alloc(8);
    key.set([4, 1]);
    key.writeUInt32BE(0x61, 4);
    c.ws.send(key);
    const update = await c.next();
    expect(update.readUInt16BE(2)).toBe(1);
    expect(update.length).toBe(4 + 12 + 9 * 14 * 4);

    const mock = p.homelab.consoles[0]!;
    expect(mock.keys).toBe(1);
    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(mock.closed).toBe(true); // upstream closed when the browser left

    // The token is single use.
    expect(await client(`${base}/${grant.token}`).closed).toBe(4403);
    const audit = await import("@/server/handlers/infra").then((m) => m.auditLog(20));
    expect(audit.some((a) => a.action === "console")).toBe(true);
  });

  it("refuses other origins, unknown tokens and stopped VMs", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "lab", false);
    const { token } = await h.openConsole(sam, vm.id);
    expect(await client(`${base}/${token}`, "https://evil.example").closed).toBe(4403);
    expect(await client(`${base}/${"x".repeat(43)}`).closed).toBe(4403);
    const ok = client(`${base}/${token}`); // the hostile attempt did not burn the token
    await ok.opened;
    expect((await ok.next()).toString()).toMatch(/^RFB/);
    ok.ws.close();

    // An unclaimed console is closed when its token expires.
    const stream = await p.homelab.openConsole("pve1", vm.vmid!);
    const expiring = p.core.holdConsole(sam.id, stream, 30);
    await new Promise((r) => setTimeout(r, 80));
    expect(p.core.claimConsole(expiring)).toBeUndefined();
    expect(p.homelab.consoles.at(-1)!.closed).toBe(true);

    await p.run(h.powerVm(sam, vm.id, "stop"));
    await expectHttp(h.openConsole(sam, vm.id), 409, /start the VM/);
    expect((await h.vmDetail(sam, vm.id)).connections).toEqual([]);
  });

  it("lists how to connect", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "lab", false);
    const ip = vm.ips[0]!;
    expect(vm.connections).toEqual([
      {
        kind: "ssh",
        label: "SSH",
        host: ip,
        hosts: [ip],
        port: 22,
        user: "ubuntu",
        command: `ssh ubuntu@${ip}`,
        url: null,
      },
    ]);
    p.cfg.clusters[1]!.connect_domain = "netbird.selfhosted";
    const { db } = await import("@/lib/db");
    await db.image.updateMany({
      where: { clusterId: "homelab" },
      data: { connect: ["ssh", "rdp", "sunshine"] },
    });
    const conns = (await h.vmDetail(sam, vm.id)).connections;
    expect(conns.map((c) => c.kind)).toEqual(["ssh", "rdp", "sunshine"]);
    expect(conns[0]).toMatchObject({
      command: "ssh ubuntu@lab.netbird.selfhosted",
      hosts: ["lab.netbird.selfhosted", ip],
    });
    expect(conns[2]!.url).toBe("https://lab.netbird.selfhosted:47990");
  });
});
