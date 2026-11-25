/** Driver interface shared by the real Proxmox client and the mock. */

export class ProxmoxError extends Error {
  override name = "ProxmoxError";
}

export interface PveNode {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
}

export interface PveVm {
  vmid: number;
  name: string;
  node: string;
  status: string;
  template: boolean;
  tags: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
}

export type PveConfig = Record<string, string | number>;
export type Params = Record<string, string | number | boolean | null | undefined>;
export interface PveBackup {
  volid: string;
  ctime: number;
  size: number;
  notes: string;
}
/** Firewall rule with Proxmox's field names; `pos` is set when read back. */
export type FirewallRule = Record<string, string | number> & { pos?: number };

export type Timeframe = "hour" | "day" | "week";
/** One sample of a VM's usage history. cpu is a 0-1 fraction of its cores; the rest are bytes (per second for net). */
export interface VmMetric {
  time: number;
  cpu: number;
  mem: number;
  maxmem: number;
  netin: number;
  netout: number;
}
/** One sample of a node's usage history. cpu is a 0-1 fraction; mem in bytes. */
export interface NodeMetric {
  time: number;
  cpu: number;
  mem: number;
  maxmem: number;
}

export interface PveSnapshot {
  name: string;
  description: string;
  /** Unix seconds. */
  time: number;
}

/** A live byte stream to a VM: its display (VNC/RFB) or its serial terminal. */
export interface ConsoleStream {
  /** VNC password the viewer must present (Proxmox's one-time ticket). Empty for terminals. */
  password: string;
  /** Terminals only: tell the far end the window size. */
  resize?(cols: number, rows: number): void;
  onData(cb: (data: Buffer) => void): void;
  onClose(cb: () => void): void;
  send(data: Buffer): void;
  close(): void;
}

/**
 * Builds a ConsoleStream whose data is buffered until the consumer attaches,
 * because the VNC server speaks first, before the browser's websocket is ready.
 */
export function bufferedStream(password: string, send: (data: Buffer) => void, close: () => void) {
  const pending: Buffer[] = [];
  let onData: ((data: Buffer) => void) | undefined;
  let onClose: (() => void) | undefined;
  let closed = false;
  const stream: ConsoleStream = {
    password,
    onData(cb) {
      onData = cb;
      for (const chunk of pending.splice(0)) cb(chunk);
    },
    onClose(cb) {
      onClose = cb;
      if (closed) cb();
    },
    send,
    close,
  };
  return {
    stream,
    push(data: Buffer) {
      if (onData) onData(data);
      else pending.push(data);
    },
    end() {
      if (closed) return;
      closed = true;
      onClose?.();
    },
  };
}

/** All mutating calls resolve once the Proxmox task has finished and reject with ProxmoxError if it failed. */
export interface ProxmoxDriver {
  nodes(): Promise<PveNode[]>;
  /** Every QEMU guest in the cluster, templates included. */
  vms(): Promise<PveVm[]>;
  vmConfig(node: string, vmid: number): Promise<PveConfig>;
  setConfig(node: string, vmid: number, params: Params): Promise<void>;
  clone(
    node: string,
    templateVmid: number,
    newid: number,
    name: string,
    storage: string,
    target?: string,
  ): Promise<void>;
  /** Create an empty VM (ISO installs). */
  createVm(node: string, vmid: number, params: Params): Promise<void>;
  resizeDisk(node: string, vmid: number, disk: string, sizeGb: number): Promise<void>;
  start(node: string, vmid: number): Promise<void>;
  /** Graceful shutdown, forced stop after `timeout` seconds. */
  shutdown(node: string, vmid: number, timeout?: number): Promise<void>;
  stop(node: string, vmid: number): Promise<void>;
  reboot(node: string, vmid: number): Promise<void>;
  migrate(node: string, vmid: number, target: string): Promise<void>;
  destroy(node: string, vmid: number): Promise<void>;
  vmIps(node: string, vmid: number): Promise<string[]>;
  /** Run a backup and return the new entry. */
  backup(
    node: string,
    vmid: number,
    storage: string,
    notes?: string,
    mode?: "snapshot" | "stop",
  ): Promise<PveBackup>;
  backups(node: string, storage: string, vmid: number): Promise<PveBackup[]>;
  restore(node: string, vmid: number, volid: string, storage: string, force?: boolean): Promise<void>;
  /** Volumes of a content type ("iso") on a storage. */
  storageContent(node: string, storage: string, content: string): Promise<{ volid: string; size: number }[]>;
  firewallSetOptions(node: string, vmid: number, options: Params): Promise<void>;
  firewallRules(node: string, vmid: number): Promise<FirewallRule[]>;
  /** Insert a rule at the top (position 0). */
  firewallAddRule(node: string, vmid: number, rule: FirewallRule): Promise<void>;
  firewallDeleteRule(node: string, vmid: number, pos: number): Promise<void>;
  /** VM firewalls only take effect when the datacenter firewall is on. */
  clusterFirewallEnabled(): Promise<boolean>;
  /** Usage history (Proxmox RRD), oldest first. Samples with no data are dropped. */
  vmMetrics(node: string, vmid: number, timeframe: Timeframe): Promise<VmMetric[]>;
  nodeMetrics(node: string, timeframe: Timeframe): Promise<NodeMetric[]>;
  /**
   * Run a shell script as root inside the guest through the QEMU guest agent,
   * waiting first for the agent to come up after boot. Resolves with the exit
   * code and combined output; rejects if the agent never answers or the script
   * outlives `timeoutMs`.
   */
  runInGuest(
    node: string,
    vmid: number,
    script: string,
    opts?: { agentWaitMs?: number; timeoutMs?: number },
  ): Promise<{ exitCode: number; output: string }>;
  /** Open the VM's graphical console. The caller must close() it. */
  openConsole(node: string, vmid: number): Promise<ConsoleStream>;
  /**
   * Open the VM's serial terminal (needs `serial0: socket` in its config and a
   * getty on ttyS0 in the guest). The stream carries plain terminal bytes.
   */
  openTerminal(node: string, vmid: number): Promise<ConsoleStream>;
  /** Disk-only snapshots, oldest first. */
  snapshots(node: string, vmid: number): Promise<PveSnapshot[]>;
  snapshot(node: string, vmid: number, name: string, description?: string): Promise<void>;
  /** Put the VM's disks back to a snapshot. A running VM ends up stopped. */
  rollback(node: string, vmid: number, name: string): Promise<void>;
  deleteSnapshot(node: string, vmid: number, name: string): Promise<void>;
  /** Set a guest account's password through the guest agent (the VM must be running). */
  setGuestPassword(node: string, vmid: number, username: string, password: string): Promise<void>;
}

export async function findVm(drv: ProxmoxDriver, vmid: number): Promise<PveVm | undefined> {
  return (await drv.vms()).find((v) => v.vmid === vmid);
}

const HOSTPCI = /^hostpci\d+$/;
const DISK_KEYS = ["scsi0", "virtio0", "sata0", "ide0"];

export function hostpciEntries(config: PveConfig): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config)
      .filter(([k]) => HOSTPCI.test(k))
      .map(([k, v]) => [k, String(v)]),
  );
}

export function freeHostpciKey(config: PveConfig): string {
  for (let i = 0; i < 16; i++) if (!(`hostpci${i}` in config)) return `hostpci${i}`;
  throw new ProxmoxError("no free hostpci slot");
}

export function diskKey(config: PveConfig): string | undefined {
  return DISK_KEYS.find((k) => k in config && !String(config[k]).includes("media=cdrom"));
}

export function diskSizeGb(value: string): number {
  const m = value.match(/size=(\d+(?:\.\d+)?)([KMGT])/);
  if (!m) return 0;
  return Number(m[1]) * { K: 1 / 1024 / 1024, M: 1 / 1024, G: 1, T: 1024 }[m[2] as "K" | "M" | "G" | "T"];
}
