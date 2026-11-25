import type { Image, Job, Reservation, Service, User, Vm } from "@prisma/client";
import { db } from "@/lib/db";
import { type PublicUser, toPublicUser } from "@/lib/public-user";
import { type ClusterConfig, hasGpus } from "@/server/config";
import type { Core } from "@/server/core";
import { ProxmoxError, type PveVm } from "@/server/proxmox/types";
import { type GpuState, gpuState } from "@/server/services/gpus";
import { connectKinds, imageOut } from "@/server/services/images";

/** What the API returns. Other people are always PublicUser (id, name, image). */

export interface LiveView {
  vms: Map<number, PveVm>;
  gpuByVmid: Map<number, string>;
  gpus: GpuState[];
  error: string | null;
}

/** Live VM + GPU-holder maps for a cluster; degrades to empty with an error string. */
export async function liveView(core: Core, clusterId: string): Promise<LiveView> {
  try {
    const cluster = core.cluster(clusterId);
    const vms = await core.liveVms(clusterId);
    const gpus = hasGpus(cluster) ? await gpuState(core, cluster) : [];
    const gpuByVmid = new Map(gpus.flatMap((g) => (g.holder ? [[g.holder.vmid, g.id] as const] : [])));
    return { vms, gpuByVmid, gpus, error: null };
  } catch (e) {
    if (!(e instanceof ProxmoxError) && !(e as Error).message?.startsWith("unknown cluster")) throw e;
    return { vms: new Map(), gpuByVmid: new Map(), gpus: [], error: (e as Error).message };
  }
}

export async function liveViews(core: Core, clusterIds: Iterable<string>): Promise<Map<string, LiveView>> {
  const ids = [...new Set(clusterIds)];
  return new Map(await Promise.all(ids.map(async (id) => [id, await liveView(core, id)] as const)));
}

export async function busyVmIds(vmIds: string[]): Promise<Set<string>> {
  if (!vmIds.length) return new Set();
  const rows = await db.job.findMany({
    where: { status: "running", vmId: { in: vmIds } },
    select: { vmId: true },
  });
  return new Set(rows.map((r) => r.vmId as string));
}

type VmRow = Vm & { owner: User; reviewedBy?: User | null };

export function vmOut(vm: VmRow, live: LiveView, busy: boolean) {
  const lv = vm.vmid !== null ? live.vms.get(vm.vmid) : undefined;
  const active = vm.status === "active";
  return {
    id: vm.id,
    clusterId: vm.clusterId,
    vmid: vm.vmid,
    name: vm.name,
    owner: toPublicUser(vm.owner),
    imageSlug: vm.imageSlug,
    setupSlug: vm.setupSlug,
    setupStatus: vm.setupStatus,
    cores: vm.cores,
    memoryMb: vm.memoryMb,
    diskGb: vm.diskGb,
    status: vm.status,
    power: active ? (live.error ? "unknown" : (lv?.status ?? "missing")) : null,
    node: lv?.node ?? null,
    uptime: lv?.uptime ?? 0,
    gpuAccess: vm.gpuAccess,
    gpu: active && vm.vmid !== null ? (live.gpuByVmid.get(vm.vmid) ?? null) : null,
    justification: vm.justification,
    reviewNote: vm.reviewNote,
    reviewedBy: vm.reviewedBy ? toPublicUser(vm.reviewedBy) : null,
    error: vm.error,
    busy,
    expiresAt: vm.expiresAt?.toISOString() ?? null,
    expired: vm.expired,
    schedule: {
      start: vm.autoStart,
      stop: vm.autoStop,
      timeZone: vm.scheduleTz,
      days: [...vm.scheduleDays].map(Number),
    },
    /** Set while the VM is flagged idle: when it was flagged. */
    idleSince: vm.status === "active" ? (vm.idleWarnedAt?.toISOString() ?? null) : null,
    labId: vm.labId,
    createdAt: vm.createdAt.toISOString(),
  };
}
export type VmOut = ReturnType<typeof vmOut>;

export function reservationOut(r: Reservation & { vm: Pick<Vm, "name">; user: User }) {
  return {
    id: r.id,
    clusterId: r.clusterId,
    vmId: r.vmId,
    vmName: r.vm.name,
    user: toPublicUser(r.user),
    startAt: r.startAt.toISOString(),
    endAt: r.endAt.toISOString(),
    status: r.status,
    gpuId: r.gpuId || null,
    note: r.note,
    error: r.error,
  };
}

export function jobOut(j: Job & { vm: Pick<Vm, "name"> | null; user: User | null }) {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    vmId: j.vmId,
    vmName: j.vm?.name ?? null,
    user: j.user ? toPublicUser(j.user) : null,
    log: j.log,
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

export function vmHosts(cluster: ClusterConfig | undefined, name: string, ips: string[]): string[] {
  return [...(cluster?.connect_domain ? [`${name}.${cluster.connect_domain}`] : []), ...ips];
}

/** How to reach a running VM over the network, per its image's connect list. */
export function connections(
  cluster: ClusterConfig | undefined,
  image: Image | null,
  name: string,
  ips: string[],
) {
  const hosts = vmHosts(cluster, name, ips);
  const host = hosts[0];
  if (!host) return [];
  const user = image?.defaultUser ?? "";
  return connectKinds(image).map((kind) => {
    if (kind === "ssh") {
      return {
        kind,
        label: "SSH",
        host,
        hosts,
        port: 22,
        user,
        command: user ? `ssh ${user}@${host}` : `ssh ${host}`,
        url: null,
      };
    }
    if (kind === "rdp") {
      return {
        kind,
        label: "Remote Desktop (RDP)",
        host,
        hosts,
        port: 3389,
        user,
        command: `${host}:3389`,
        url: null,
      };
    }
    return {
      kind,
      label: "Moonlight (Sunshine)",
      host,
      hosts,
      port: 47989,
      user: "",
      command: host,
      url: `https://${host}:47990`,
    };
  });
}

export function serviceOut(core: Core, s: Service & { vm: Vm & { owner: User } }, ips: string[] = []) {
  const host = vmHosts(core.findCluster(s.vm.clusterId), s.vm.name, ips)[0];
  const address = host ? `${host}:${s.port}` : null;
  return {
    id: s.id,
    vmId: s.vmId,
    vmName: s.vm.name,
    clusterId: s.vm.clusterId,
    owner: toPublicUser(s.vm.owner),
    name: s.name,
    description: s.description,
    port: s.port,
    protocol: s.protocol,
    scheme: s.scheme,
    status: s.status,
    reviewNote: s.reviewNote,
    address,
    url: s.scheme && address ? `${s.scheme}://${address}` : null,
    createdAt: s.createdAt.toISOString(),
  };
}

export { imageOut, type PublicUser };
