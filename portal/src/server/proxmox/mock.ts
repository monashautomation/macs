import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BlockList } from "node:net";
import type { ClusterConfig } from "@/server/config";
import {
  bufferedStream,
  type ConsoleStream,
  type FirewallRule,
  hostpciEntries,
  type Params,
  type ProxmoxDriver,
  ProxmoxError,
  type PveBackup,
  type PveConfig,
  type Timeframe,
} from "./types";

interface Guest {
  vmid: number;
  name: string;
  node: string;
  status: "running" | "stopped";
  template: boolean;
  config: PveConfig;
  started: number;
  firewall?: { options: Record<string, string | number>; rules: FirewallRule[] };
}
type StoredBackup = PveBackup & { vmid: number; storage: string; guest: Guest };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * In-memory Proxmox stand-in for local development and tests.
 *
 * It enforces the constraints that matter for GPU orchestration (a passthrough
 * device backs one running VM, raw PCI ids are node-local, running VMs do not
 * migrate) and evaluates firewall rules, so the app's logic is exercised
 * realistically.
 */
export class MockProxmox implements ProxmoxDriver {
  nodeNames: string[];
  guests = new Map<number, Guest>();
  backupStore: StoredBackup[] = [];
  datacenterFirewall = true;
  isos: { volid: string; size: number }[];
  consoles: MockConsole[] = [];
  private readonly stateFile?: string;

  constructor(
    readonly cfg: ClusterConfig,
    private readonly opts: { delayMs?: number; demo?: boolean; stateFile?: string } = {},
  ) {
    this.nodeNames = [...new Set(cfg.gpu.devices.map((d) => d.node))].sort();
    if (!this.nodeNames.length) this.nodeNames = ["pve1", "pve2", "pve3"];
    this.isos = cfg.iso_storage
      ? (
          [
            ["debian-12.8.0-amd64-netinst.iso", 631],
            ["ubuntu-24.04.1-live-server-amd64.iso", 2640],
            ["nixos-minimal-24.11-x86_64-linux.iso", 1105],
            ["Win11_24H2_English_x64.iso", 5550],
          ] as const
        ).map(([name, mb]) => ({ volid: `${cfg.iso_storage}:iso/${name}`, size: mb * 1024 ** 2 }))
      : [];
    this.stateFile = opts.stateFile;
    if (this.stateFile && existsSync(this.stateFile)) {
      const state = JSON.parse(readFileSync(this.stateFile, "utf8")) as {
        guests: Guest[];
        backups: StoredBackup[];
      };
      for (const g of state.guests) this.guests.set(g.vmid, g);
      this.backupStore = state.backups;
      return;
    }
    for (const t of cfg.templates) {
      if (t.kind !== "template" || t.vmid === undefined) continue;
      this.guests.set(t.vmid, {
        ...this.guest(t.vmid, t.id, this.nodeNames[0] ?? "pve1", {
          cores: 2,
          memory: 2048,
          net0: "virtio=BC:24:11:00:00:01,bridge=vmbr0",
          scsi0: `${cfg.storage}:base-${t.vmid}-disk-0,size=20G`,
        }),
        template: true,
      });
    }
    if (opts.demo && cfg.gpu.devices.length) {
      // Something for the "unmanaged VM holding a GPU" paths to chew on.
      const d = cfg.gpu.devices.at(-1);
      if (d) {
        const device = cfg.gpu.mapping ? `mapping=${cfg.gpu.mapping}` : d.pci;
        this.seedVm(cfg.vmid_range[0] - 1, "legacy-sim-box", d.node, true, { hostpci0: `${device},pcie=1` });
      }
    }
    this.save();
  }

  private guest(vmid: number, name: string, node: string, config: PveConfig = {}): Guest {
    return { vmid, name, node, status: "stopped", template: false, config: { name, ...config }, started: 0 };
  }

  private save() {
    if (!this.stateFile) return;
    writeFileSync(
      this.stateFile,
      JSON.stringify({ guests: [...this.guests.values()], backups: this.backupStore }),
    );
  }

  private async work() {
    if (this.opts.delayMs) await sleep(this.opts.delayMs);
  }

  private get(node: string, vmid: number): Guest {
    const g = this.guests.get(vmid);
    if (!g) throw new ProxmoxError(`VM ${vmid} does not exist`);
    if (g.node !== node) throw new ProxmoxError(`VM ${vmid} is not on node ${node}`);
    return g;
  }

  seedVm(vmid: number, name: string, node: string, running = false, config: PveConfig = {}) {
    const g = this.guest(vmid, name, node, {
      cores: 4,
      memory: 8192,
      scsi0: `${this.cfg.storage}:vm-${vmid}-disk-0,size=40G`,
      ...config,
    });
    if (running) {
      g.status = "running";
      g.started = Date.now();
    }
    this.guests.set(vmid, g);
    this.save();
  }

  // -- inventory ---------------------------------------------------------

  async nodes() {
    return this.nodeNames.map((node) => {
      const running = [...this.guests.values()].filter((g) => g.node === node && g.status === "running");
      const cores = running.reduce((n, g) => n + Number(g.config.cores ?? 1), 0);
      const memMb = running.reduce((n, g) => n + Number(g.config.memory ?? 0), 0);
      return {
        node,
        status: "online",
        cpu: Math.min(0.95, cores / 64),
        maxcpu: 64,
        mem: memMb * 1024 * 1024,
        maxmem: 256 * 1024 ** 3,
      };
    });
  }

  async vms() {
    return [...this.guests.values()].map((g) => {
      const up = g.status === "running";
      const maxmem = Number(g.config.memory ?? 0) * 1024 * 1024;
      return {
        vmid: g.vmid,
        name: g.name,
        node: g.node,
        status: g.status,
        template: g.template,
        tags: String(g.config.tags ?? ""),
        cpu: up ? 0.07 : 0,
        maxcpu: Number(g.config.cores ?? 1),
        mem: up ? maxmem * 0.4 : 0,
        maxmem,
        uptime: up ? Math.floor((Date.now() - g.started) / 1000) : 0,
      };
    });
  }

  async vmConfig(node: string, vmid: number) {
    return { ...this.get(node, vmid).config };
  }

  async setConfig(node: string, vmid: number, params: Params) {
    const g = this.get(node, vmid);
    const { delete: remove, ...rest } = params;
    for (const key of String(remove ?? "").split(",")) delete g.config[key.trim()];
    for (const [k, v] of Object.entries(rest)) {
      if (v !== null && v !== undefined) g.config[k] = typeof v === "boolean" ? Number(v) : v;
    }
    if (typeof rest.name === "string") g.name = rest.name;
    this.save();
  }

  // -- lifecycle ---------------------------------------------------------

  async clone(
    node: string,
    templateVmid: number,
    newid: number,
    name: string,
    storage: string,
    target?: string,
  ) {
    const src = this.get(node, templateVmid);
    if (this.guests.has(newid)) throw new ProxmoxError(`VM ${newid} already exists`);
    await this.work();
    const { name: _n, ...config } = src.config;
    this.guests.set(
      newid,
      this.guest(newid, name, target ?? node, { ...config, scsi0: `${storage}:vm-${newid}-disk-0,size=20G` }),
    );
    this.save();
  }

  async createVm(node: string, vmid: number, params: Params) {
    if (this.guests.has(vmid)) throw new ProxmoxError(`VM ${vmid} already exists`);
    if (!this.nodeNames.includes(node)) throw new ProxmoxError(`no such node ${node}`);
    await this.work();
    const { name, ...rest } = params;
    const config: PveConfig = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v === null || v === undefined) continue;
      // Like Proxmox, "storage:40" allocates a 40G volume.
      const m = (k === "scsi0" || k === "sata0") && String(v).match(/^([^:]+):(\d+)/);
      config[k] = m ? `${m[1]}:vm-${vmid}-disk-0,size=${m[2]}G` : typeof v === "boolean" ? Number(v) : v;
    }
    this.guests.set(vmid, this.guest(vmid, String(name ?? `vm-${vmid}`), node, config));
    this.save();
  }

  async resizeDisk(node: string, vmid: number, disk: string, sizeGb: number) {
    const g = this.get(node, vmid);
    g.config[disk] = `${String(g.config[disk]).replace(/,size=[^,]+$/, "")},size=${sizeGb}G`;
    this.save();
  }

  private checkPassthrough(g: Guest) {
    const onNode = this.cfg.gpu.devices.filter((d) => d.node === g.node);
    for (const value of Object.values(hostpciEntries(g.config))) {
      const first = value.split(",")[0] ?? "";
      const busy = [...this.guests.values()]
        .filter((o) => o !== g && o.node === g.node && o.status === "running")
        .reduce((n, o) => n + Object.keys(hostpciEntries(o.config)).length, 0);
      if (first.startsWith("mapping=")) {
        if (!onNode.length)
          throw new ProxmoxError(`start failed: PCI mapping has no device on node ${g.node}`);
      } else if (!onNode.some((d) => d.pci === first)) {
        throw new ProxmoxError(`start failed: no PCI device ${first} on node ${g.node}`);
      }
      if (busy >= onNode.length)
        throw new ProxmoxError("start failed: PCI device is already in use by another VM");
    }
  }

  async start(node: string, vmid: number) {
    const g = this.get(node, vmid);
    if (g.template) throw new ProxmoxError("cannot start a template");
    if (g.status === "running") return;
    this.checkPassthrough(g);
    await this.work();
    g.status = "running";
    g.started = Date.now();
    this.save();
  }

  shutdown(node: string, vmid: number) {
    return this.stop(node, vmid);
  }

  async stop(node: string, vmid: number) {
    const g = this.get(node, vmid);
    if (g.status === "stopped") return;
    await this.work();
    g.status = "stopped";
    this.save();
  }

  async reboot(node: string, vmid: number) {
    const g = this.get(node, vmid);
    if (g.status !== "running") throw new ProxmoxError(`VM ${vmid} not running`);
    await this.work();
    g.started = Date.now();
  }

  async migrate(node: string, vmid: number, target: string) {
    const g = this.get(node, vmid);
    if (!this.nodeNames.includes(target)) throw new ProxmoxError(`no such node ${target}`);
    if (g.status === "running") throw new ProxmoxError("mock only supports offline migration");
    await this.work();
    g.node = target;
    this.save();
  }

  async destroy(node: string, vmid: number) {
    const g = this.get(node, vmid);
    if (g.status === "running") throw new ProxmoxError(`VM ${vmid} is running - destroy failed`);
    this.guests.delete(vmid);
    this.save();
  }

  async vmIps(node: string, vmid: number) {
    return this.get(node, vmid).status === "running" ? [`10.20.${Math.floor(vmid / 256)}.${vmid % 256}`] : [];
  }

  // -- backups -----------------------------------------------------------

  async backups(_node: string, storage: string, vmid: number): Promise<PveBackup[]> {
    return this.backupStore
      .filter((b) => b.vmid === vmid && b.storage === storage)
      .map(({ volid, ctime, size, notes }) => ({ volid, ctime, size, notes }));
  }

  async backup(node: string, vmid: number, storage: string, notes = "") {
    const g = this.get(node, vmid);
    await this.work();
    const ctime = Math.floor(Date.now() / 1000);
    const stamp = `${new Date(ctime * 1000).toISOString().slice(0, 19)}Z`;
    let volid = `${storage}:backup/vm/${vmid}/${stamp}`;
    for (let n = 2; this.backupStore.some((b) => b.volid === volid); n++) {
      volid = `${storage}:backup/vm/${vmid}/${stamp}-${n}`;
    }
    const entry: StoredBackup = { volid, ctime, size: 12 * 1024 ** 3, notes, vmid, storage, guest: clone(g) };
    this.backupStore.push(entry);
    this.save();
    return { volid, ctime, size: entry.size, notes };
  }

  async restore(node: string, vmid: number, volid: string, _storage: string, force = false) {
    const b = this.backupStore.find((x) => x.volid === volid);
    if (!b) throw new ProxmoxError(`no such backup ${volid}`);
    const existing = this.guests.get(vmid);
    if (existing && !force) throw new ProxmoxError(`VM ${vmid} already exists`);
    if (existing?.status === "running") throw new ProxmoxError(`VM ${vmid} is running`);
    await this.work();
    this.guests.set(vmid, { ...clone(b.guest), vmid, node, status: "stopped" });
    this.save();
  }

  async storageContent(_node: string, storage: string, content: string) {
    return content === "iso" && storage === this.cfg.iso_storage ? this.isos.map((i) => ({ ...i })) : [];
  }

  // -- firewall ----------------------------------------------------------

  private fw(node: string, vmid: number) {
    const g = this.get(node, vmid);
    g.firewall ??= { options: {}, rules: [] };
    return g.firewall;
  }

  async firewallSetOptions(node: string, vmid: number, options: Params) {
    for (const [k, v] of Object.entries(options)) {
      if (v !== null && v !== undefined)
        this.fw(node, vmid).options[k] = typeof v === "boolean" ? Number(v) : v;
    }
    this.save();
  }

  async firewallRules(node: string, vmid: number) {
    return this.fw(node, vmid).rules.map((r, pos) => ({ ...r, pos }));
  }

  async firewallAddRule(node: string, vmid: number, rule: FirewallRule) {
    this.fw(node, vmid).rules.unshift({ ...rule });
    this.save();
  }

  async firewallDeleteRule(node: string, vmid: number, pos: number) {
    this.fw(node, vmid).rules.splice(pos, 1);
    this.save();
  }

  async clusterFirewallEnabled() {
    return this.datacenterFirewall;
  }

  /** Would a packet from `source` to this VM's port get through its firewall? */
  reachable(vmid: number, source: string, port: number, proto = "tcp"): boolean {
    const g = this.guests.get(vmid);
    if (!g) throw new Error(`no VM ${vmid}`);
    const fw = g.firewall ?? { options: {}, rules: [] };
    const nics = Object.entries(g.config)
      .filter(([k]) => /^net\d+$/.test(k))
      .map(([, v]) => String(v));
    const filtered =
      this.datacenterFirewall && !!fw.options.enable && nics.every((n) => n.includes("firewall=1"));
    if (!filtered) return true;
    for (const r of fw.rules) {
      if (r.type !== "in" || (r.proto ?? proto) !== proto) continue;
      if (r.dport !== undefined && String(r.dport) !== String(port)) continue;
      if (r.source !== undefined) {
        const list = new BlockList();
        for (const c of String(r.source).split(",")) {
          const [ip = "", bits] = c.split("/");
          if (bits) list.addSubnet(ip, Number(bits));
          else list.addAddress(ip);
        }
        if (!list.check(source)) continue;
      }
      return r.action === "ACCEPT";
    }
    return (fw.options.policy_in ?? "DROP") === "ACCEPT";
  }

  // -- usage history ----------------------------------------------------

  /** Plausible, repeatable curves: the same VM draws the same shape every time. */
  private series(seed: number, timeframe: Timeframe, since = 0) {
    const [step, count] = { hour: [60, 60], day: [1800, 48], week: [3600 * 3, 56] }[timeframe] as [
      number,
      number,
    ];
    const end = Math.floor(Date.now() / 1000 / step) * step;
    const wave = (t: number, k: number) => 0.5 + 0.5 * Math.sin((t / step + seed * 7) / k);
    return Array.from({ length: count }, (_, i) => end - (count - 1 - i) * step)
      .filter((time) => time >= since)
      .map((time) => ({ time, a: wave(time, 5), b: wave(time, 11), c: wave(time, 3) }));
  }

  async vmMetrics(node: string, vmid: number, timeframe: Timeframe) {
    const g = this.get(node, vmid);
    if (g.status !== "running") return [];
    const maxmem = Number(g.config.memory ?? 0) * 1024 * 1024;
    return this.series(vmid, timeframe, Math.floor(g.started / 1000)).map(({ time, a, b, c }) => ({
      time,
      cpu: 0.05 + 0.55 * a * b,
      mem: maxmem * (0.3 + 0.4 * b),
      maxmem,
      netin: 40_000 + 900_000 * c * a,
      netout: 15_000 + 300_000 * c * b,
    }));
  }

  async nodeMetrics(node: string, timeframe: Timeframe) {
    const index = this.nodeNames.indexOf(node);
    if (index < 0) throw new ProxmoxError(`no such node ${node}`);
    const maxmem = 256 * 1024 ** 3;
    return this.series(index + 1, timeframe).map(({ time, a, b }) => ({
      time,
      cpu: 0.04 + 0.3 * a * b,
      mem: maxmem * (0.15 + 0.25 * b),
      maxmem,
    }));
  }

  // -- console -----------------------------------------------------------

  async openConsole(node: string, vmid: number): Promise<ConsoleStream> {
    const g = this.get(node, vmid);
    if (g.status !== "running") throw new ProxmoxError(`VM ${vmid} is not running`);
    const c = new MockConsole(g.name);
    this.consoles.push(c);
    return c.stream;
  }
}

/**
 * A tiny RFB 3.8 server: one static screen, plus a block drawn per key press
 * so input can be seen to arrive. Enough for a real noVNC client.
 */
export class MockConsole {
  static readonly WIDTH = 800;
  static readonly HEIGHT = 450;
  keys = 0;
  closed = false;
  readonly stream: ConsoleStream;
  private readonly out: ReturnType<typeof bufferedStream>;
  private inbox = Buffer.alloc(0);
  private waiting?: { n: number; resolve: (b: Buffer) => void };

  constructor(private readonly name: string) {
    this.out = bufferedStream(
      "mock",
      (data) => {
        this.inbox = Buffer.concat([this.inbox, data]);
        this.pump();
      },
      () => {
        this.closed = true;
        this.out.end();
      },
    );
    this.stream = this.out.stream;
    void this.serve();
  }

  private pump() {
    if (this.waiting && this.inbox.length >= this.waiting.n) {
      const { n, resolve } = this.waiting;
      this.waiting = undefined;
      const chunk = this.inbox.subarray(0, n);
      this.inbox = this.inbox.subarray(n);
      resolve(chunk);
    }
  }

  private read(n: number): Promise<Buffer> {
    return new Promise((resolve) => {
      this.waiting = { n, resolve };
      this.pump();
    });
  }

  private rect(x: number, y: number, w: number, h: number, rgb: number[], shifts: number[]): Buffer {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(x, 0);
    head.writeUInt16BE(y, 2);
    head.writeUInt16BE(w, 4);
    head.writeUInt16BE(h, 6);
    head.writeInt32BE(0, 8); // raw encoding
    const pixel = Buffer.alloc(4);
    pixel.writeUInt32LE(rgb.reduce((acc, c, i) => (acc | (c << (shifts[i] ?? 0))) >>> 0, 0));
    return Buffer.concat([head, Buffer.alloc(w * h * 4, pixel)]);
  }

  private async serve() {
    const put = (b: Buffer) => this.out.push(b);
    const { WIDTH, HEIGHT } = MockConsole;
    put(Buffer.from("RFB 003.008\n"));
    await this.read(12);
    put(Buffer.from([1, 1])); // one security type: None
    await this.read(1);
    put(Buffer.alloc(4)); // SecurityResult OK
    await this.read(1); // ClientInit
    const title = Buffer.from(`${this.name} (mock console)`);
    const init = Buffer.alloc(24);
    init.writeUInt16BE(WIDTH, 0);
    init.writeUInt16BE(HEIGHT, 2);
    init.set([32, 24, 0, 1], 4); // bpp, depth, little-endian, true colour
    init.writeUInt16BE(255, 8);
    init.writeUInt16BE(255, 10);
    init.writeUInt16BE(255, 12);
    init.set([16, 8, 0], 14); // rgb shifts
    init.writeUInt32BE(title.length, 20);
    put(Buffer.concat([init, title]));

    let shifts = [16, 8, 0];
    let drawn = 0;
    let painted = false;
    let waiting = false;
    /** Send whatever changed; like a real server, stay silent if nothing did. */
    const flush = (full: boolean): boolean => {
      const rects: Buffer[] = [];
      if (full || !painted) {
        painted = true;
        drawn = 0;
        rects.push(this.rect(0, 0, WIDTH, HEIGHT, [16, 20, 28], shifts));
        [260, 420, 180].forEach((w, i) =>
          rects.push(this.rect(24, 28 + 22 * i, w, 10, [90, 200, 130], shifts)),
        );
      }
      for (; drawn < this.keys; drawn++) {
        rects.push(
          this.rect(
            24 + 12 * (drawn % 60),
            110 + 22 * Math.floor(drawn / 60),
            9,
            14,
            [230, 230, 230],
            shifts,
          ),
        );
      }
      if (rects.length) {
        const head = Buffer.alloc(4);
        head.writeUInt16BE(rects.length, 2);
        put(Buffer.concat([head, ...rects]));
      }
      return rects.length > 0;
    };

    for (;;) {
      const kind = (await this.read(1))[0] ?? -1;
      if (kind === 0) {
        const fmt = await this.read(19); // SetPixelFormat
        shifts = [fmt[13] ?? 16, fmt[14] ?? 8, fmt[15] ?? 0];
      } else if (kind === 2) {
        const count = (await this.read(3)).readUInt16BE(1); // SetEncodings
        await this.read(4 * count);
      } else if (kind === 3) {
        const incremental = (await this.read(9))[0]; // FramebufferUpdateRequest
        waiting = !flush(!incremental);
      } else if (kind === 4) {
        this.keys += (await this.read(7))[0] ?? 0; // KeyEvent: count key-downs
        if (waiting) waiting = !flush(false); // answer the request the viewer left open
      } else if (kind === 5) {
        await this.read(5); // PointerEvent
      } else if (kind === 6) {
        const length = (await this.read(7)).readUInt32BE(3); // ClientCutText
        await this.read(length);
      } else {
        break;
      }
    }
    this.out.end();
  }
}
