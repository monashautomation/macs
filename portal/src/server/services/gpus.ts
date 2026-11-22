import { db } from "@/lib/db";
import type { ClusterConfig } from "@/server/config";
import type { Core, Log } from "@/server/core";
import { findVm, freeHostpciKey, hostpciEntries, ProxmoxError, type PveVm } from "@/server/proxmox/types";

/**
 * GPU passthrough tracking and swapping.
 *
 * Who holds a GPU is always read from the VMs' Proxmox config (hostpciN), so
 * the view is correct even for VMs changed outside the portal.
 */
export interface GpuHolder {
  vmid: number;
  name: string;
  status: string;
  key: string;
}
export interface GpuState {
  id: string;
  node: string;
  model: string;
  pci: string;
  holder: GpuHolder | null;
}

/** '0000:01:00.0' / '01:00' -> '01:00' (domain 0, function dropped). */
function normPci(addr: string): string {
  const a = addr.trim().toLowerCase().split(".")[0] ?? "";
  return a.startsWith("0000:") ? a.slice(5) : a;
}

/** One entry per configured GPU with its current holder (or null). */
export async function gpuState(core: Core, cluster: ClusterConfig, fresh = false): Promise<GpuState[]> {
  if (fresh) core.invalidate(cluster.id);
  return core.cached(cluster.id, "gpus", async () => {
    const drv = core.driver(cluster.id);
    const guests = (await drv.vms()).filter((v) => !v.template);
    const scanned: [PveVm, Record<string, string>][] = [];
    // A handful at a time: one config read per VM.
    for (let i = 0; i < guests.length; i += 8) {
      const batch = guests.slice(i, i + 8).map(async (v): Promise<[PveVm, Record<string, string>]> => {
        try {
          return [v, hostpciEntries(await drv.vmConfig(v.node, v.vmid))];
        } catch (e) {
          if (e instanceof ProxmoxError) return [v, {}]; // VM vanished or moved mid-scan
          throw e;
        }
      });
      scanned.push(...(await Promise.all(batch)));
    }
    const state: GpuState[] = cluster.gpu.devices.map((d) => ({ ...d, holder: null }));
    const hold = (g: GpuState, v: PveVm, key: string) => {
      g.holder = { vmid: v.vmid, name: v.name, status: v.status, key };
    };
    const mapped: [PveVm, string][] = [];
    for (const [v, entries] of scanned) {
      for (const [key, value] of Object.entries(entries)) {
        const first = value.split(",")[0] ?? "";
        if (first.startsWith("mapping=")) {
          if (cluster.gpu.mapping && first === `mapping=${cluster.gpu.mapping}`) mapped.push([v, key]);
          continue;
        }
        const g = state.find(
          (x) => x.node === v.node && x.pci && !x.holder && normPci(x.pci) === normPci(first),
        );
        if (g) hold(g, v, key);
      }
    }
    // A mapping resolves to whichever device is free on the VM's node; running VMs claim first.
    mapped.sort((a, b) => Number(a[0].status !== "running") - Number(b[0].status !== "running"));
    for (const [v, key] of mapped) {
      const g = state.find((x) => x.node === v.node && !x.holder);
      if (g) hold(g, v, key);
    }
    return state;
  });
}

function hostpciValue(cluster: ClusterConfig, gpu: GpuState): string {
  const device = cluster.gpu.mapping ? `mapping=${cluster.gpu.mapping}` : gpu.pci;
  return cluster.gpu.hostpci_opts ? `${device},${cluster.gpu.hostpci_opts}` : device;
}

async function vmidsWhere(clusterId: string, activeBooking: boolean): Promise<Set<number>> {
  const rows = await db.vm.findMany({
    where: {
      clusterId,
      status: "active",
      vmid: { not: null },
      ...(activeBooking ? { reservations: { some: { status: "active" } } } : {}),
    },
    select: { vmid: true },
  });
  return new Set(rows.map((r) => r.vmid as number));
}

async function strip(
  core: Core,
  cluster: ClusterConfig,
  holder: GpuHolder,
  node: string,
  log: Log,
  restart: boolean,
) {
  const drv = core.driver(cluster.id);
  const wasRunning = holder.status !== "stopped";
  if (wasRunning) {
    log(`shutting down ${holder.name} (${holder.vmid})`);
    await drv.shutdown(node, holder.vmid, cluster.gpu.shutdown_timeout_seconds);
  }
  log(`detaching GPU from ${holder.name} (${holder.vmid})`);
  await drv.setConfig(node, holder.vmid, { delete: holder.key });
  if (wasRunning && restart) {
    log(`restarting ${holder.name} without a GPU`);
    await drv.start(node, holder.vmid);
  }
}

/**
 * Give `vmid` a GPU and boot it. Resolves to the GPU id.
 *
 * gpuId given: take exactly that GPU, evicting whoever holds it (infra swap).
 * Otherwise pick a free GPU, preferring the VM's current node; with `preempt`,
 * fall back to a GPU held by a portal VM that has no active booking.
 */
export function attachGpu(
  core: Core,
  cluster: ClusterConfig,
  vmid: number,
  log: Log,
  opts: { gpuId?: string; preempt?: boolean } = {},
): Promise<string> {
  const drv = core.driver(cluster.id);
  return core.withLock(`gpu:${cluster.id}`, async () => {
    const state = await gpuState(core, cluster, true);
    const target = await findVm(drv, vmid);
    if (!target) throw new ProxmoxError(`VM ${vmid} not found on ${cluster.name}`);
    const mine = state.find((g) => g.holder?.vmid === vmid);

    let gpu: GpuState | undefined;
    if (opts.gpuId) {
      gpu = state.find((g) => g.id === opts.gpuId);
      if (!gpu) throw new ProxmoxError(`unknown GPU ${opts.gpuId}`);
    } else if (mine) {
      gpu = mine;
    } else {
      let free = state.filter((g) => !g.holder);
      if (!free.length && opts.preempt) {
        const [managed, reserved] = await Promise.all([
          vmidsWhere(cluster.id, false),
          vmidsWhere(cluster.id, true),
        ]);
        free = state.filter((g) => g.holder && managed.has(g.holder.vmid) && !reserved.has(g.holder.vmid));
      }
      if (!free.length) throw new ProxmoxError("no GPU is free right now");
      gpu = free.reduce((best, g) =>
        Number(g.node !== target.node) < Number(best.node !== target.node) ? g : best,
      );
    }

    if (mine && mine.id === gpu.id) {
      if (target.status !== "running") {
        log(`${target.name} already has ${gpu.id}; starting it`);
        await drv.start(target.node, vmid);
      } else {
        log(`${target.name} already has ${gpu.id}`);
      }
      return gpu.id;
    }
    if (gpu.node !== target.node && !cluster.shared_storage) {
      throw new ProxmoxError(
        `${gpu.id} is on ${gpu.node} but ${target.name} is on ${target.node}, and this cluster has no shared storage to migrate with`,
      );
    }
    try {
      if (gpu.holder) await strip(core, cluster, gpu.holder, gpu.node, log, true);
      if (target.status !== "stopped") {
        log(`shutting down ${target.name} (${vmid})`);
        await drv.shutdown(target.node, vmid, cluster.gpu.shutdown_timeout_seconds);
      }
      if (mine?.holder) {
        log(`detaching ${mine.id} from ${target.name}`);
        await drv.setConfig(target.node, vmid, { delete: mine.holder.key });
      }
      if (gpu.node !== target.node) {
        log(`migrating ${target.name} from ${target.node} to ${gpu.node}`);
        await drv.migrate(target.node, vmid, gpu.node);
      }
      const key = freeHostpciKey(await drv.vmConfig(gpu.node, vmid));
      log(`attaching ${gpu.id} (${gpu.model}) to ${target.name} as ${key}`);
      await drv.setConfig(gpu.node, vmid, { [key]: hostpciValue(cluster, gpu) });
      log(`starting ${target.name}`);
      await drv.start(gpu.node, vmid);
    } finally {
      core.invalidate(cluster.id);
    }
    return gpu.id;
  });
}

/** Remove any pool GPU from `vmid`. Resolves false if it held none. */
export function detachGpu(
  core: Core,
  cluster: ClusterConfig,
  vmid: number,
  log: Log,
  restart = true,
): Promise<boolean> {
  return core.withLock(`gpu:${cluster.id}`, async () => {
    const held = (await gpuState(core, cluster, true)).filter((g) => g.holder?.vmid === vmid);
    if (!held.length) {
      log("no GPU attached");
      return false;
    }
    const first = held[0] as GpuState;
    const wasRunning = first.holder?.status !== "stopped";
    try {
      for (const [i, gpu] of held.entries()) {
        // Only the first strip needs the shutdown.
        const holder = { ...(gpu.holder as GpuHolder), ...(i > 0 ? { status: "stopped" } : {}) };
        await strip(core, cluster, holder, gpu.node, log, false);
      }
      if (restart && wasRunning) {
        log("restarting without a GPU");
        await core.driver(cluster.id).start(first.node, vmid);
      }
    } finally {
      core.invalidate(cluster.id);
    }
    return true;
  });
}
