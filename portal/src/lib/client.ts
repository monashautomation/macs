"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type * as infra from "@/server/handlers/infra";
import type * as vms from "@/server/handlers/vms";

/** Browser-side API access. Types come straight from the server handlers. */

type Out<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
export type Session = Out<typeof vms.session>;
export type Cluster = Out<typeof vms.listClusters>[number];
export type Image = Cluster["images"][number];
export type Setup = Cluster["setups"][number];
export type Created = Out<typeof vms.createVm>;
export type AdminSetup = Out<typeof infra.adminSetups>[number];
export type Vm = Out<typeof vms.listVms>[number];
export type VmDetail = Out<typeof vms.vmDetail>;
export type Job = VmDetail["jobs"][number];
export type Reservation = VmDetail["reservations"][number];
export type Service = VmDetail["services"][number];
export type Connection = VmDetail["connections"][number];
export type GpuCluster = Out<typeof vms.listGpus>[number];
export type GpuDevice = GpuCluster["devices"][number];
export type Approvals = Out<typeof infra.approvals>;
export type Overview = Out<typeof infra.overview>[number];
export type AdminImages = Out<typeof infra.adminImages>;
export type AdminImage = AdminImages["images"][number];
export type Person = Out<typeof infra.people>[number];
export type AuditRow = Out<typeof infra.auditLog>[number];
export type Unmanaged = Out<typeof infra.unmanaged>[number];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401) {
    window.location.assign("/"); // session expired: back to sign-in
    throw new ApiError(401, "Sign in required");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

const LIVE = 5000;
const get = <T>(key: unknown[], path: string, refetchInterval: number | false = LIVE, enabled = true) =>
  useQuery({ queryKey: key, queryFn: () => api<T>(path), refetchInterval, enabled });

export const useSession = () => get<Session>(["session"], "/session", false);
export const useClusters = () => get<Cluster[]>(["clusters"], "/clusters", 30_000);
export const useVms = (scope: "mine" | "all" = "mine") => get<Vm[]>(["vms", scope], `/vms?scope=${scope}`);
export const useVm = (id: string) => get<VmDetail>(["vm", id], `/vms/${id}`);
export const useGpus = () => get<GpuCluster[]>(["gpus"], "/gpus");
export const useServices = () => get<Service[]>(["services"], "/services", 30_000);
export const useReservations = (clusterId: string, start: Date, end: Date) =>
  get<Reservation[]>(
    ["reservations", clusterId, start.toISOString()],
    `/reservations?clusterId=${clusterId}&start=${start.toISOString()}&end=${end.toISOString()}`,
    15_000,
  );
export const useApprovals = (enabled = true) =>
  get<Approvals>(["approvals"], "/admin/approvals", 15_000, enabled);
export const useOverview = () => get<Overview[]>(["overview"], "/admin/overview", 10_000);
export type VmMetrics = Out<typeof vms.vmMetrics>;
export type ClusterMetrics = Out<typeof infra.clusterMetrics>[number];
export const useVmMetrics = (id: string, timeframe: "hour" | "day" | "week", enabled: boolean) =>
  get<VmMetrics>(["vm-metrics", id, timeframe], `/vms/${id}/metrics?timeframe=${timeframe}`, 30_000, enabled);
export function useClusterMetrics() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return get<ClusterMetrics[]>(
    ["cluster-metrics", today.toISOString()],
    `/admin/metrics?timeframe=day&today=${today.toISOString()}`,
    60_000,
  );
}
export const pendingCount = (a?: Approvals) => (a ? a.vms.length + a.services.length : 0);

/** A mutation that refreshes every live query when it settles and toasts failures. */
export function useAct<TArgs = void, TOut = unknown>(
  fn: (args: TArgs) => Promise<TOut>,
  opts: { quiet?: boolean; success?: string | ((args: TArgs) => string) } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => qc.invalidateQueries(),
    onSuccess: (_out, args) => {
      if (opts.success) toast.success(typeof opts.success === "string" ? opts.success : opts.success(args));
    },
    onError: (e) => {
      if (!opts.quiet) toast.error(e.message);
    },
  });
}

/**
 * The generated first-login password is returned once, when the VM is created.
 * Keep it for this browser tab only, so the VM page can show it until dismissed.
 */
const loginKey = (vmId: string) => `macs-login-${vmId}`;
export function rememberLogin(created: Created) {
  if (created.login) sessionStorage.setItem(loginKey(created.id), JSON.stringify(created.login));
}
export function recallLogin(vmId: string): { user: string; password: string } | null {
  try {
    return JSON.parse(sessionStorage.getItem(loginKey(vmId)) ?? "null");
  } catch {
    return null;
  }
}
export const forgetLogin = (vmId: string) => sessionStorage.removeItem(loginKey(vmId));
