import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { parse } from "yaml";
import { z } from "zod";
import { env } from "@/env";

/**
 * Cluster configuration: one YAML file (MACS_CONFIG). String values may use
 * ${VAR} or ${VAR:-default}, so Proxmox tokens stay in OpenBao/env, not the file.
 * Keys are snake_case to match the file.
 */

const cidr = z.string().refine((v) => {
  const [ip, bits, ...rest] = v.split("/");
  const version = isIP(ip ?? "");
  if (!version || rest.length) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return /^\d+$/.test(bits) && n <= (version === 4 ? 32 : 128);
}, "must be an IP address or CIDR");

const connectKind = z.enum(["ssh", "rdp", "sunshine"]);
export type ConnectKind = z.infer<typeof connectKind>;

/** Seeds the image library on first start; afterwards it is curated in the app. */
const template = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["template", "iso"]).default("template"),
    vmid: z.number().int().optional(),
    volid: z.string().default(""),
    os: z.enum(["linux", "windows", "other"]).default("linux"),
    description: z.string().default(""),
    default_user: z.string().default(""),
    /** Proxmox cicustom value, e.g. "vendor=cephfs:snippets/macs-vendor.yaml". */
    cicustom: z.string().default(""),
    /** NVIDIA drivers baked in: works with the passthrough GPUs out of the box. */
    gpu_ready: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
    connect: z.array(connectKind).default([]),
  })
  .refine(
    (t) => (t.kind === "template" ? t.vmid !== undefined : !!t.volid),
    "template needs vmid; iso needs volid",
  );

const network = z.object({
  label: z.string().default(""),
  description: z.string().default(""),
  /** Per-VM Proxmox firewall, inbound dropped by default, so VMs cannot reach each other. */
  isolate: z.boolean().default(false),
  /** Ports the owner uses to get in, and who may reach them (empty = anywhere). */
  access_ports: z.array(z.number().int().min(1).max(65535)).default([22]),
  access_sources: z.array(cidr).default([]),
  /** Let owners publish further ports as "public services", reachable from public_sources. */
  services: z.boolean().default(false),
  service_approval: z.enum(["none", "required"]).default("none"),
  public_sources: z.array(cidr).default([]),
  max_services_per_vm: z.number().int().min(0).default(5),
});

const gpuDevice = z.object({
  id: z.string().min(1),
  node: z.string().min(1),
  /** PCI address as Proxmox wants it, e.g. "0000:01:00". */
  pci: z.string().default(""),
  model: z.string().default("GPU"),
});

const gpu = z
  .object({
    /** Proxmox PCI resource mapping name. Recommended: API tokens cannot attach raw PCI ids. */
    mapping: z.string().default(""),
    hostpci_opts: z.string().default("pcie=1"),
    max_reservation_hours: z.number().positive().default(72),
    max_advance_days: z.number().positive().default(30),
    shutdown_timeout_seconds: z.number().int().positive().default(120),
    devices: z.array(gpuDevice).default([]),
  })
  .refine(
    (g) => new Set(g.devices.map((d) => d.id)).size === g.devices.length,
    "gpu device ids must be unique",
  )
  .refine(
    (g) => !!g.mapping || g.devices.every((d) => d.pci),
    "each gpu device needs pci unless gpu.mapping is set",
  );

const cluster = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    kind: z.enum(["research", "homelab"]).default("homelab"),
    description: z.string().default(""),
    driver: z.enum(["proxmox", "mock"]).default("proxmox"),
    endpoint: z.string().default(""),
    /** API token auth (preferred): "user@realm!name" + secret. */
    token_id: z.string().default(""),
    token_secret: z.string().default(""),
    /** Or ticket auth, needed for raw (unmapped) PCI passthrough as root@pam. */
    username: z.string().default(""),
    password: z.string().default(""),
    verify_tls: z.boolean().default(true),
    /** Authentik groups allowed to use this cluster. Empty = every member of the app. */
    allowed_groups: z.array(z.string()).default([]),
    /** required: infra approves each VM request. none: self-service within quota. */
    approval: z.enum(["required", "none"]).default("required"),
    storage: z.string().default("local-lvm"),
    /** VM disks on shared storage (Ceph): spread VMs and migrate them to a free GPU. */
    shared_storage: z.boolean().default(false),
    bridge: z.string().default(""),
    vlan: z.number().int().nullable().default(null),
    vmid_range: z.tuple([z.number().int(), z.number().int()]).default([1000, 1999]),
    /** Show <vm-name>.<connect_domain> (e.g. the NetBird domain) ahead of raw IPs. */
    connect_domain: z.string().default(""),
    /** Proxmox storage id of the PBS datastore. Empty = no backups. */
    backup_storage: z.string().default(""),
    /** Proxmox storage whose ISOs can be added to the image library. */
    iso_storage: z.string().default(""),
    /** Offer the ready-made setup library (one-click installs) on this cluster. */
    setups: z.boolean().default(false),
    /** Image slug that one-click setups are installed on. Default: the first Debian/Ubuntu template in the library. */
    default_image: z.string().default(""),
    /** Offer multi-VM labs (several VMs deployed together that can reach each other). */
    labs: z.boolean().default(false),
    /**
     * Days a VM runs before it is shut down unless someone extends it (it is
     * never deleted). 0 = VMs do not expire.
     */
    lifetime_days: z.number().int().min(0).default(0),
    /** How long before expiry the owner is warned. */
    expiry_warning_days: z.number().int().min(1).default(3),
    /**
     * Shut down VMs that have done nothing for this many days (1-7; 0 = off).
     * The owner is warned first and can keep the VM running. Nothing is deleted.
     */
    idle_days: z.number().int().min(0).max(7).default(0),
    /** Days between the idle warning and the shut-down. */
    idle_grace_days: z.number().int().min(1).default(2),
    /** A VM is idle while its CPU stays under this (percent of its cores)... */
    idle_cpu_percent: z.number().positive().max(50).default(2),
    /** ...and its network traffic under this (KB/s, in plus out). */
    idle_network_kbps: z.number().positive().default(20),
    /** Snapshots a VM may hold at once. 0 = snapshots off. */
    max_snapshots: z.number().int().min(0).default(3),
    network: network.default(() => network.parse({})),
    /** Per-VM ceilings. */
    limits: z
      .object({
        max_cores: z.number().int().positive().default(8),
        max_memory_mb: z.number().int().positive().default(16384),
        max_disk_gb: z.number().int().positive().default(100),
      })
      .default({ max_cores: 8, max_memory_mb: 16384, max_disk_gb: 100 }),
    /** Per-user totals on this cluster. 0 = unlimited. */
    quota: z
      .object({
        max_vms: z.number().int().min(0).default(0),
        max_cores: z.number().int().min(0).default(0),
        max_memory_mb: z.number().int().min(0).default(0),
        max_disk_gb: z.number().int().min(0).default(0),
      })
      .default({ max_vms: 0, max_cores: 0, max_memory_mb: 0, max_disk_gb: 0 }),
    templates: z.array(template).default([]),
    gpu: gpu.default(() => gpu.parse({})),
  })
  .refine(
    (c) =>
      c.driver === "mock" ||
      (!!c.endpoint && ((!!c.token_id && !!c.token_secret) || (!!c.username && !!c.password))),
    "proxmox clusters need endpoint and token_id/token_secret (or username/password)",
  );

const schema = z
  .object({ clusters: z.array(cluster).default([]) })
  .refine(
    (c) => new Set(c.clusters.map((x) => x.id)).size === c.clusters.length,
    "cluster ids must be unique",
  );

export type ClusterConfig = z.infer<typeof cluster>;
export type GpuDeviceConfig = z.infer<typeof gpuDevice>;
export type TemplateConfig = z.infer<typeof template>;
export type MacsConfig = z.infer<typeof schema>;

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

type Vars = Record<string, string | undefined>;

function expand(value: unknown, vars: Vars): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_REF, (_m, name: string, fallback?: string) => {
      const got = vars[name] ?? fallback;
      if (got === undefined) throw new Error(`config references unset environment variable ${name}`);
      return got;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, vars)]));
  }
  return value;
}

export function parseConfig(yamlText: string, vars: Vars = process.env): MacsConfig {
  return schema.parse(expand(parse(yamlText) ?? {}, vars));
}

let cached: MacsConfig | undefined;

export function config(): MacsConfig {
  cached ??= parseConfig(readFileSync(env().MACS_CONFIG, "utf8"));
  return cached;
}

export const hasGpus = (c: ClusterConfig) => c.gpu.devices.length > 0;

/** Admins use every cluster; otherwise the cluster's groups decide (empty = all members). */
export function canUse(c: ClusterConfig, who: { groups: string[]; roles: Set<string> }): boolean {
  return (
    who.roles.has("admin") ||
    c.allowed_groups.length === 0 ||
    c.allowed_groups.some((g) => who.groups.includes(g))
  );
}
