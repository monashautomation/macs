import { describe, expect, it } from "vitest";
import { parseConfig } from "@/server/config";
import { ProxmoxClient } from "@/server/proxmox/client";
import { ProxmoxError } from "@/server/proxmox/types";

const UPID = "UPID:pve1:0001:0002:0003:qmclone:9000:macs@pve!portal:";

type Seen = { method: string; path: string; headers: Record<string, string>; body: string };

/** The real client against scripted HTTP responses. */
function make(auth: string, respond: (req: Seen) => { status?: number; json: unknown }) {
  const cfg = parseConfig(`clusters: [{ id: c, name: C, endpoint: "https://pve:8006", ${auth} }]`)
    .clusters[0]!;
  const client = new ProxmoxClient(cfg);
  const seen: Seen[] = [];
  client.pollMs = 0;
  client.fetchImpl = (async (
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: URLSearchParams },
  ) => {
    const u = new URL(url);
    const req = {
      method: init.method,
      path: u.pathname + u.search,
      headers: init.headers ?? {},
      body: init.body?.toString() ?? "",
    };
    seen.push(req);
    const { status = 200, json } = respond(req);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof client.fetchImpl;
  return { client, seen };
}
const token = 'token_id: "macs@pve!portal", token_secret: s3cret';

describe("Proxmox client", () => {
  it("authenticates with the API token and waits for tasks", async () => {
    const polls = ["running", "stopped"];
    const { client, seen } = make(token, (req) =>
      req.path.endsWith("/clone")
        ? { json: { data: UPID } }
        : { json: { data: { status: polls.shift(), exitstatus: "OK" } } },
    );
    await client.clone("pve1", 9000, 1000, "box", "ceph", "pve2");
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api2/json/nodes/pve1/qemu/9000/clone" });
    expect(seen[0]!.headers.Authorization).toBe("PVEAPIToken=macs@pve!portal=s3cret");
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({
      newid: "1000",
      name: "box",
      full: "1",
      storage: "ceph",
      target: "pve2",
    });
    expect(seen.length).toBe(3);
    expect(seen[1]!.path).toContain("/nodes/pve1/tasks/UPID%3Apve1");
  });

  it("raises when a task fails or Proxmox refuses", async () => {
    const failing = make(token, (req) =>
      req.method === "POST"
        ? { json: { data: UPID } }
        : { json: { data: { status: "stopped", exitstatus: "can't lock file" } } },
    );
    await expect(failing.client.start("pve1", 100)).rejects.toThrow(/can't lock file/);
    const denied = make(token, () => ({
      status: 403,
      json: { data: null, message: "Permission check failed" },
    }));
    await expect(denied.client.vmConfig("pve1", 100)).rejects.toThrow(ProxmoxError);
    await expect(denied.client.vmConfig("pve1", 100)).rejects.toThrow(/403 Permission check failed/);
  });

  it("logs in once with a ticket and reuses it", async () => {
    const { client, seen } = make("username: root@pam, password: pw", (req) =>
      req.path.endsWith("/access/ticket")
        ? { json: { data: { ticket: "TICKET", CSRFPreventionToken: "CSRF" } } }
        : { json: { data: null } },
    );
    await client.setConfig("pve1", 100, { delete: "hostpci0" });
    await client.setConfig("pve1", 100, { hostpci0: "0000:01:00,pcie=1", skip: undefined, flag: true });
    expect(seen.map((r) => r.path.split("/").pop())).toEqual(["ticket", "config", "config"]);
    expect(seen[1]).toMatchObject({
      method: "PUT",
      headers: { CSRFPreventionToken: "CSRF", Cookie: "PVEAuthCookie=TICKET" },
    });
    expect(Object.fromEntries(new URLSearchParams(seen[2]!.body))).toEqual({
      hostpci0: "0000:01:00,pcie=1",
      flag: "1",
    });
  });

  it("lists only QEMU guests and tolerates a missing guest agent", async () => {
    const { client } = make(token, (req) =>
      req.path.includes("agent")
        ? { status: 500, json: { data: null, message: "QEMU guest agent is not running" } }
        : {
            json: {
              data: [
                { type: "qemu", vmid: 100, name: "a", node: "pve1", status: "running", template: 0 },
                { type: "lxc", vmid: 200, name: "ct", node: "pve1", status: "running" },
                { type: "qemu", vmid: 9000, name: "tpl", node: "pve1", status: "stopped", template: 1 },
              ],
            },
          },
    );
    expect((await client.vms()).map((v) => [v.vmid, v.template])).toEqual([
      [100, false],
      [9000, true],
    ]);
    expect(await client.vmIps("pve1", 100)).toEqual([]);
  });

  it("puts query parameters in the URL for GET and DELETE", async () => {
    const { client, seen } = make(token, () => ({ json: { data: [] } }));
    await client.backups("pve1", "pbs", 100);
    await client.firewallDeleteRule("pve1", 100, 3);
    expect(seen[0]!.path).toBe("/api2/json/nodes/pve1/storage/pbs/content?content=backup&vmid=100");
    expect(seen[1]).toMatchObject({
      method: "DELETE",
      path: "/api2/json/nodes/pve1/qemu/100/firewall/rules/3",
      body: "",
    });
  });
});

describe("cluster config", () => {
  it("expands environment references and applies defaults", () => {
    const cfg = parseConfig(
      'clusters: [{ id: a, name: A, endpoint: "https://x", token_id: t, token_secret: "${TOK}", bridge: "${BR:-vmbr1}" }]',
      { TOK: "secret" },
    );
    expect(cfg.clusters[0]).toMatchObject({
      token_secret: "secret",
      bridge: "vmbr1",
      approval: "required",
      vmid_range: [1000, 1999],
    });
    expect(cfg.clusters[0]!.network).toMatchObject({ isolate: false, access_ports: [22] });
  });

  it("rejects bad config with a reason", () => {
    expect(() =>
      parseConfig(
        'clusters: [{ id: a, name: A, endpoint: "https://x", token_id: t, token_secret: "${MISSING}" }]',
        {},
      ),
    ).toThrow(/MISSING/);
    expect(() => parseConfig("clusters: [{ id: a, name: A }]")).toThrow(/endpoint/);
    expect(() =>
      parseConfig("clusters: [{ id: a, name: A, driver: mock }, { id: a, name: B, driver: mock }]"),
    ).toThrow(/unique/);
    expect(() =>
      parseConfig("clusters: [{ id: a, name: A, driver: mock, network: { access_sources: [not-an-ip] } }]"),
    ).toThrow(/CIDR/);
    expect(() =>
      parseConfig("clusters: [{ id: a, name: A, driver: mock, gpu: { devices: [{ id: g, node: n }] } }]"),
    ).toThrow(/pci/);
    expect(() =>
      parseConfig("clusters: [{ id: a, name: A, driver: mock, templates: [{ id: t, name: T, kind: iso }] }]"),
    ).toThrow(/volid/);
  });
});
