import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: { "X-MACS": "1", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = typeof data.detail === "string" ? data.detail : (data.detail?.[0]?.msg ?? detail);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

export interface UserRef { id: number; username: string; name: string }
export interface Me extends UserRef { email: string; groups: string[]; is_admin: boolean; ssh_public_key: string }
export interface AuthConfig { app_name: string; mode: "oidc" | "dev"; dev_users: { username: string; name: string; groups: string[] }[] }
export interface Image {
  id: string; name: string; kind: "template" | "iso"; os: "linux" | "windows" | "other"; description: string;
  default_user: string; gpu_ready: boolean; tags: string[];
}
export interface AdminImage extends Image {
  db_id: number; cluster_id: string; vmid: number | null; volid: string; cicustom: string;
  connect: ("ssh" | "rdp" | "sunshine")[] | null; enabled: boolean; vm_count: number; missing: boolean;
}
export interface Service {
  id: number; vm_id: number; vm_name: string; cluster_id: string; owner: UserRef; name: string; description: string;
  port: number; protocol: "tcp" | "udp"; scheme: "" | "http" | "https"; status: "pending" | "published" | "rejected";
  review_note: string; address: string | null; url: string | null; created_at: string;
}
export interface Cluster {
  id: string; name: string; kind: "research" | "homelab"; description: string; approval: "required" | "none";
  has_gpus: boolean; gpu_count: number; has_backups: boolean;
  limits: { max_cores: number; max_memory_mb: number; max_disk_gb: number };
  quota: { max_vms: number; max_cores: number; max_memory_mb: number; max_disk_gb: number };
  usage: { vms: number; cores: number; memory_mb: number; disk_gb: number };
  gpu_rules: { max_reservation_hours: number; max_advance_days: number };
  images: Image[];
  network: { label: string; description: string; isolated: boolean; services: boolean; service_approval: "none" | "required"; max_services_per_vm: number };
  nodes: { node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number }[];
  error: string | null;
}
export interface VM {
  id: number; cluster_id: string; vmid: number | null; name: string; owner: UserRef; template_id: string;
  cores: number; memory_mb: number; disk_gb: number;
  status: "pending" | "rejected" | "provisioning" | "active" | "error" | "archived" | "deleted";
  power: "running" | "stopped" | "missing" | "unknown" | string | null;
  node: string | null; uptime: number; gpu_access: "none" | "requested" | "approved"; gpu: string | null;
  justification: string; review_note: string; reviewed_by: UserRef | null; error: string; busy: boolean; created_at: string;
}
export interface Job {
  id: number; kind: string; status: "running" | "succeeded" | "failed"; vm_id: number | null; vm_name: string | null;
  user: UserRef | null; log: string; error: string; created_at: string; finished_at: string | null;
}
export interface Reservation {
  id: number; cluster_id: string; vm_id: number; vm_name: string; user: UserRef; start_at: string; end_at: string;
  status: "scheduled" | "active" | "completed" | "cancelled" | "failed"; gpu_id: string | null; note: string; error: string;
}
export interface Backup { id: number; volid: string; notes: string; size: number; created_at: string }
export interface Connection {
  kind: "ssh" | "rdp" | "sunshine"; label: string; host: string; hosts: string[]; port: number; user: string; command: string; url?: string;
}
export interface VMDetail extends VM {
  connections: Connection[]; image: Image | null; services: Service[]; ips: string[]; jobs: Job[]; reservations: Reservation[]; backups: Backup[];
}
export interface GpuDevice {
  id: string; node: string; model: string;
  holder: { vmid: number; name: string; power: string; vm_id: number | null; owner: UserRef | null; booked_until: string | null } | null;
}
export interface GpuCluster { cluster_id: string; cluster_name: string; devices: GpuDevice[]; error: string | null }

const LIVE = 5000;

export const useAuthConfig = () => useQuery({ queryKey: ["auth-config"], queryFn: () => api<AuthConfig>("/api/auth/config"), staleTime: Infinity });
export const useMe = () =>
  useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me"), retry: false, staleTime: 60_000 });
export const useClusters = () => useQuery({ queryKey: ["clusters"], queryFn: () => api<Cluster[]>("/api/clusters"), refetchInterval: 30_000 });
export const useVMs = (scope: "mine" | "all" = "mine") =>
  useQuery({ queryKey: ["vms", scope], queryFn: () => api<VM[]>(`/api/vms?scope=${scope}`), refetchInterval: LIVE });
export const useVM = (id: number) =>
  useQuery({ queryKey: ["vm", id], queryFn: () => api<VMDetail>(`/api/vms/${id}`), refetchInterval: LIVE });
export const useGpus = () => useQuery({ queryKey: ["gpus"], queryFn: () => api<GpuCluster[]>("/api/gpus"), refetchInterval: LIVE });
export const useReservations = (clusterId: string, start: Date, end: Date) =>
  useQuery({
    queryKey: ["reservations", clusterId, start.toISOString()],
    queryFn: () => api<Reservation[]>(`/api/reservations?cluster_id=${clusterId}&start=${start.toISOString()}&end=${end.toISOString()}`),
    refetchInterval: 15_000,
  });
export interface Approvals { vms: VM[]; services: Service[] }
export const useApprovals = (enabled: boolean) =>
  useQuery({ queryKey: ["approvals"], queryFn: () => api<Approvals>("/api/admin/approvals"), refetchInterval: 15_000, enabled });
export const pendingCount = (a?: Approvals) => (a ? a.vms.length + a.services.length : 0);
export const useServices = () => useQuery({ queryKey: ["services"], queryFn: () => api<Service[]>("/api/services"), refetchInterval: 30_000 });

export interface Overview {
  id: string; name: string; kind: string; error: string | null; nodes: Cluster["nodes"];
  vms: { managed: number; owners: number; archived: number; running: number; unmanaged: number };
  allocated: { cores: number; memory_mb: number; disk_gb: number };
  capacity: { cores: number; memory_mb: number };
  gpus: { total: number; in_use: number; booked: number; upcoming: number } | null;
  pending: { vms: number; gpu: number; services: number };
  network: {
    label: string; isolated: boolean; services: boolean; published: number; firewall_ok: boolean | null;
    access_ports: number[]; access_sources: string[]; public_sources: string[]; service_approval: string;
    bridge: string; vlan: number | null;
  };
  images: number;
}
export const useOverview = () => useQuery({ queryKey: ["overview"], queryFn: () => api<Overview[]>("/api/admin/overview"), refetchInterval: 10_000 });

/** A mutation that refreshes every live query when it settles. */
export function useAct<TArgs = void, TOut = unknown>(fn: (args: TArgs) => Promise<TOut>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries() });
}
