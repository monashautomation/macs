import { db } from "@/lib/db";
import type { Core, Log } from "@/server/core";
import {
  diskKey,
  diskSizeGb,
  hostpciEntries,
  type Params,
  type ProxmoxDriver,
  ProxmoxError,
} from "@/server/proxmox/types";
import { relinkLab } from "./labs";
import { applyNetworkPolicy } from "./network";
import { locate, provision } from "./vms";

/** Snapshots, rebuild and resize: things an owner does to a VM they already have. */

/** Proxmox snapshot names: a letter, then letters, digits, dash or underscore. */
export const SNAPSHOT_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{1,39}$/;

async function onCluster(core: Core, vmId: string) {
  const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId } });
  const live = await locate(core, vm);
  if (!live || vm.vmid === null) throw new ProxmoxError(`VM ${vm.vmid} not found on the cluster`);
  return { vm, live, vmid: vm.vmid, node: live.node, drv: core.driver(vm.clusterId) };
}

/**
 * After the VM's config has been replaced by an older copy (a snapshot or a
 * backup), make passthrough reflect today's GPU assignment, not the copy's.
 */
export async function keepPassthrough(
  drv: ProxmoxDriver,
  node: string,
  vmid: number,
  keep: Record<string, string>,
) {
  const stale = hostpciEntries(await drv.vmConfig(node, vmid));
  if (JSON.stringify(stale) === JSON.stringify(keep)) return;
  if (Object.keys(stale).length) await drv.setConfig(node, vmid, { delete: Object.keys(stale).join(",") });
  if (Object.keys(keep).length) await drv.setConfig(node, vmid, keep);
}

export async function takeSnapshot(core: Core, vmId: string, name: string, description: string, log: Log) {
  const { vmid, node, drv } = await onCluster(core, vmId);
  log(`taking snapshot ${name}`);
  await drv.snapshot(node, vmid, name, description);
  log("done");
}

export async function rollbackSnapshot(core: Core, vmId: string, name: string, log: Log) {
  const { vm, live, vmid, node, drv } = await onCluster(core, vmId);
  const keep = hostpciEntries(await drv.vmConfig(node, vmid));
  log(`rolling back to snapshot ${name}`);
  await drv.rollback(node, vmid, name);
  await keepPassthrough(drv, node, vmid, keep);
  await applyNetworkPolicy(core, vmId, log);
  // Disk-only snapshots leave the VM off; put it back the way it was.
  if (live.status === "running" && !vm.expired) {
    log("starting");
    await drv.start(node, vmid);
  }
  log("rolled back");
}

export async function removeSnapshot(core: Core, vmId: string, name: string, log: Log) {
  const { vmid, node, drv } = await onCluster(core, vmId);
  log(`deleting snapshot ${name}`);
  await drv.deleteSnapshot(node, vmid, name);
  log("done");
}

/**
 * Wipe the VM and deploy it again from the same image and setup. The portal's
 * record survives: name, owner, size, sharing and published ports.
 */
export async function rebuildVm(core: Core, vmId: string, log: Log) {
  const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId } });
  const live = await locate(core, vm);
  if (live && vm.vmid !== null) {
    const drv = core.driver(vm.clusterId);
    if (live.status !== "stopped") {
      log("stopping");
      await drv.stop(live.node, vm.vmid);
    }
    log(`erasing VM ${vm.vmid}`);
    await drv.destroy(live.node, vm.vmid);
    core.invalidate(vm.clusterId);
  }
  await db.vm.update({
    where: { id: vmId },
    data: { status: "provisioning", setupStatus: vm.setupSlug ? "pending" : "none" },
  });
  await provision(core, vmId, log);
  if (vm.labId) await relinkLab(core, vm.labId, log);
}

export interface Size {
  cores: number;
  memoryMb: number;
  diskGb: number;
}

/** Apply a new size. CPU and memory need the VM off, so a running VM is restarted. */
export async function resizeVm(core: Core, vmId: string, want: Size, log: Log) {
  const { vm, live, vmid, node, drv } = await onCluster(core, vmId);
  const params: Params = {};
  if (want.cores !== vm.cores) params.cores = want.cores;
  if (want.memoryMb !== vm.memoryMb) params.memory = want.memoryMb;
  const restart = live.status === "running" && Object.keys(params).length > 0;
  if (restart) {
    log("shutting down to change CPU and memory");
    await drv.shutdown(node, vmid);
  }
  try {
    if (Object.keys(params).length) {
      log(`setting ${want.cores} cores, ${want.memoryMb} MB`);
      await drv.setConfig(node, vmid, params);
      await db.vm.update({ where: { id: vmId }, data: { cores: want.cores, memoryMb: want.memoryMb } });
    }
    if (want.diskGb > vm.diskGb) {
      const config = await drv.vmConfig(node, vmid);
      const disk = diskKey(config);
      if (!disk) throw new ProxmoxError("could not find the VM's disk");
      if (diskSizeGb(String(config[disk])) < want.diskGb) {
        log(`growing ${disk} to ${want.diskGb} GB`);
        await drv.resizeDisk(node, vmid, disk, want.diskGb);
      }
      await db.vm.update({ where: { id: vmId }, data: { diskGb: want.diskGb } });
    }
  } finally {
    if (restart) {
      log("starting");
      await drv.start(node, vmid);
    }
  }
  log("resized");
}
