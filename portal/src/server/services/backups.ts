import { db } from "@/lib/db";
import type { Core, Log } from "@/server/core";
import { hostpciEntries, ProxmoxError, type PveBackup } from "@/server/proxmox/types";
import { detachGpu } from "./gpus";
import { keepPassthrough } from "./lifecycle";
import { applyNetworkPolicy } from "./network";
import { closeReservations, locate, pickNode } from "./vms";

/** Backups to Proxmox Backup Server, plus archive (backup + destroy) and restore. */

function record(vmId: string, entry: PveBackup, notes: string) {
  return db.backup.create({
    data: {
      vmId,
      volid: entry.volid,
      notes,
      sizeBytes: BigInt(Math.round(entry.size || 0)),
      createdAt: new Date(entry.ctime * 1000),
    },
  });
}

export async function backupVm(core: Core, vmId: string, notes: string, log: Log) {
  const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId } });
  const cluster = core.cluster(vm.clusterId);
  const live = await locate(core, vm);
  if (!live || vm.vmid === null) throw new ProxmoxError(`VM ${vm.vmid} not found on the cluster`);
  log(`backing up VM ${vm.vmid} to ${cluster.backup_storage}`);
  const entry = await core
    .driver(cluster.id)
    .backup(live.node, vm.vmid, cluster.backup_storage, notes || vm.name);
  await record(vmId, entry, notes);
  log(`backup complete: ${entry.volid}`);
}

/** Shut the VM down, back it up, then destroy it to free cluster resources. */
export async function archiveVm(core: Core, vmId: string, log: Log) {
  const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId } });
  const cluster = core.cluster(vm.clusterId);
  const drv = core.driver(cluster.id);
  let live = await locate(core, vm);
  if (!live || vm.vmid === null) throw new ProxmoxError(`VM ${vm.vmid} not found on the cluster`);
  const vmid = vm.vmid;
  await closeReservations(vmId);
  if (cluster.gpu.devices.length) {
    // Never bake a passthrough device into an archive.
    await detachGpu(core, cluster, vmid, log, false);
    live = (await locate(core, vm)) ?? live;
  }
  if (live.status !== "stopped") {
    log("shutting down");
    await drv.shutdown(live.node, vmid);
  }
  log(`backing up VM ${vmid} to ${cluster.backup_storage}`);
  const notes = `archive of ${vm.name}`;
  const entry = await drv.backup(live.node, vmid, cluster.backup_storage, notes, "stop");
  await record(vmId, entry, notes);
  log(`backup complete: ${entry.volid}; destroying VM ${vmid}`);
  await drv.destroy(live.node, vmid);
  await db.vm.update({ where: { id: vmId }, data: { status: "archived" } });
  core.kick();
  log("archived");
}

/** Restore a backup: recreates an archived VM, or rolls an existing one back. */
export async function restoreVm(core: Core, vmId: string, volid: string, log: Log) {
  const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId } });
  const cluster = core.cluster(vm.clusterId);
  const drv = core.driver(cluster.id);
  if (vm.vmid === null) throw new ProxmoxError("this VM was never provisioned");
  const vmid = vm.vmid;
  const live = await locate(core, vm);
  let node: string;
  let keep: Record<string, string> = {};
  if (vm.status === "archived") {
    if (live)
      throw new ProxmoxError(`VMID ${vmid} is in use on the cluster; infrastructure needs to free it first`);
    node = await pickNode(core, cluster, null);
    log(`restoring ${volid} to VM ${vmid} on ${node}`);
    await drv.restore(node, vmid, volid, cluster.storage);
  } else {
    if (!live) throw new ProxmoxError(`VM ${vmid} not found on the cluster`);
    node = live.node;
    keep = hostpciEntries(await drv.vmConfig(node, vmid));
    if (live.status !== "stopped") {
      log("shutting down");
      await drv.shutdown(node, vmid);
    }
    log(`rolling VM ${vmid} back to ${volid}`);
    await drv.restore(node, vmid, volid, cluster.storage, true);
  }
  // The backup carries the config from when it was taken; passthrough must
  // reflect today's GPU assignment instead.
  await keepPassthrough(drv, node, vmid, keep);
  core.invalidate(cluster.id);
  // Likewise the firewall: a backup must not resurrect old published ports.
  await db.vm.update({ where: { id: vmId }, data: { status: "active", error: "" } });
  await applyNetworkPolicy(core, vmId, log);
  log("starting");
  await drv.start(node, vmid);
  log("restored");
}
