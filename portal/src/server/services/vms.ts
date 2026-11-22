import type { Image, Vm } from "@prisma/client";
import { db } from "@/lib/db";
import type { ClusterConfig } from "@/server/config";
import type { Core, Log } from "@/server/core";
import { diskKey, diskSizeGb, findVm, type Params, ProxmoxError, type PveVm } from "@/server/proxmox/types";
import { getImage } from "./images";
import { applyNetworkPolicy } from "./network";

/** Statuses that count against quota and hold a name. */
export const VM_LIVE = ["pending", "provisioning", "active"];

export function tagSafe(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.+-]/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

export async function usage(userId: string, clusterId: string) {
  const agg = await db.vm.aggregate({
    where: { ownerId: userId, clusterId, status: { in: VM_LIVE } },
    _count: true,
    _sum: { cores: true, memoryMb: true, diskGb: true },
  });
  return {
    vms: agg._count,
    cores: agg._sum.cores ?? 0,
    memoryMb: agg._sum.memoryMb ?? 0,
    diskGb: agg._sum.diskGb ?? 0,
  };
}

export function quotaError(
  cluster: ClusterConfig,
  used: Awaited<ReturnType<typeof usage>>,
  want: { cores: number; memoryMb: number; diskGb: number },
): string | null {
  const q = cluster.quota;
  const checks: [string, number, number][] = [
    ["VMs", used.vms + 1, q.max_vms],
    ["cores", used.cores + want.cores, q.max_cores],
    ["MB of memory", used.memoryMb + want.memoryMb, q.max_memory_mb],
    ["GB of disk", used.diskGb + want.diskGb, q.max_disk_gb],
  ];
  for (const [label, total, limit] of checks) {
    if (limit && total > limit) {
      return `over your quota on ${cluster.name}: ${total} ${label} requested in total, limit is ${limit}`;
    }
  }
  return null;
}

async function allocateVmid(core: Core, cluster: ClusterConfig): Promise<number> {
  const live = new Set((await core.driver(cluster.id).vms()).map((v) => v.vmid));
  // Archived VMs keep their id so their backups can never be mistaken for a newer VM's.
  const taken = new Set(
    (
      await db.vm.findMany({
        where: { clusterId: cluster.id, vmid: { not: null }, status: { not: "deleted" } },
        select: { vmid: true },
      })
    ).map((v) => v.vmid),
  );
  const [lo, hi] = cluster.vmid_range;
  for (let vmid = lo; vmid <= hi; vmid++) if (!live.has(vmid) && !taken.has(vmid)) return vmid;
  throw new ProxmoxError(`no free VMID in ${lo}-${hi}`);
}

/** Emptiest online node on shared storage; otherwise stay where the source is. */
export async function pickNode(core: Core, cluster: ClusterConfig, fallback: string | null): Promise<string> {
  const online = (await core.driver(cluster.id).nodes()).filter((n) => n.status === "online");
  if (!online.length) throw new ProxmoxError("no node is online");
  if (cluster.shared_storage || fallback === null) {
    return online.reduce((best, n) => (n.maxmem - n.mem > best.maxmem - best.mem ? n : best)).node;
  }
  return fallback;
}

async function fromTemplate(core: Core, cluster: ClusterConfig, vm: Vm, image: Image, log: Log) {
  const drv = core.driver(cluster.id);
  const templateVmid = image.vmid as number;
  const { node, vmid } = await core.withLock(`provision:${cluster.id}`, async () => {
    const src = await findVm(drv, templateVmid);
    if (!src) throw new ProxmoxError(`template VM ${templateVmid} not found on ${cluster.name}`);
    const vmid = await allocateVmid(core, cluster);
    const node = await pickNode(core, cluster, src.node);
    log(`cloning template ${image.name} (${templateVmid}) to VM ${vmid} on ${node}`);
    await drv.clone(src.node, templateVmid, vmid, vm.name, cluster.storage, node);
    await db.vm.update({ where: { id: vm.id }, data: { vmid } });
    return { node, vmid };
  });

  const params: Params = { cores: vm.cores, memory: vm.memoryMb, onboot: 0 };
  if (cluster.bridge)
    params.net0 = `virtio,bridge=${cluster.bridge}${cluster.vlan ? `,tag=${cluster.vlan}` : ""}`;
  if (image.os === "linux") {
    if (image.defaultUser) params.ciuser = image.defaultUser;
    params.ipconfig0 = "ip=dhcp";
    // Proxmox wants this value URL-encoded on top of the form encoding.
    if (vm.sshPublicKey.trim()) params.sshkeys = encodeURIComponent(vm.sshPublicKey.trim());
  }
  if (image.cicustom) params.cicustom = image.cicustom;
  log(`configuring ${vm.cores} cores, ${vm.memoryMb} MB`);
  await drv.setConfig(node, vmid, params);

  const config = await drv.vmConfig(node, vmid);
  const disk = diskKey(config);
  if (disk && diskSizeGb(String(config[disk])) < vm.diskGb) {
    log(`growing ${disk} to ${vm.diskGb} GB`);
    await drv.resizeDisk(node, vmid, disk, vm.diskGb);
  }
  return { node, vmid };
}

/** A blank UEFI/q35 VM (so a GPU can be passed through later) booting the installer. */
async function fromIso(core: Core, cluster: ClusterConfig, vm: Vm, image: Image, log: Log) {
  const drv = core.driver(cluster.id);
  const storage = image.volid.split(":")[0] ?? "";
  return core.withLock(`provision:${cluster.id}`, async () => {
    let node = await pickNode(core, cluster, null);
    const has = async (n: string) =>
      (await drv.storageContent(n, storage, "iso")).some((v) => v.volid === image.volid);
    // ISO storage may be node-local: go where the file is.
    if (!(await has(node))) {
      let found: string | undefined;
      for (const n of await drv.nodes()) {
        if (n.status === "online" && (await has(n.node))) {
          found = n.node;
          break;
        }
      }
      if (!found) throw new ProxmoxError(`ISO ${image.volid} not found on any node`);
      node = found;
    }
    const vmid = await allocateVmid(core, cluster);
    const windows = image.os === "windows";
    // Windows setup has no virtio drivers, so give it SATA + e1000.
    const disk = windows ? "sata0" : "scsi0";
    const params: Params = {
      name: vm.name,
      cores: vm.cores,
      memory: vm.memoryMb,
      cpu: "host",
      onboot: 0,
      agent: 1,
      machine: "q35",
      bios: "ovmf",
      efidisk0: `${cluster.storage}:1,efitype=4m,pre-enrolled-keys=0`,
      scsihw: "virtio-scsi-single",
      [disk]: `${cluster.storage}:${vm.diskGb}`,
      ide2: `${image.volid},media=cdrom`,
      boot: `order=${disk};ide2`,
      net0: `${windows ? "e1000" : "virtio"},bridge=${cluster.bridge || "vmbr0"}${cluster.vlan ? `,tag=${cluster.vlan}` : ""}`,
      ostype: windows ? "win11" : image.os === "linux" ? "l26" : "other",
    };
    if (windows) params.tpmstate0 = `${cluster.storage}:1,version=v2.0`;
    log(`creating VM ${vmid} on ${node} with installer ${image.name}`);
    await drv.createVm(node, vmid, params);
    await db.vm.update({ where: { id: vm.id }, data: { vmid } });
    return { node, vmid };
  });
}

export async function provision(core: Core, vmId: string, log: Log): Promise<void> {
  const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId }, include: { owner: true } });
  const cluster = core.cluster(vm.clusterId);
  const drv = core.driver(cluster.id);
  let image: Image | null = null;
  try {
    image = await getImage(vm.clusterId, vm.imageSlug);
    if (!image) throw new ProxmoxError(`image ${vm.imageSlug} is no longer in the library`);
    const { node, vmid } = await (image.kind === "iso" ? fromIso : fromTemplate)(
      core,
      cluster,
      vm,
      image,
      log,
    );
    await drv.setConfig(node, vmid, {
      tags: `macs;owner-${tagSafe(vm.owner.email.split("@")[0] ?? "")}`,
      description: `Managed by the MACS portal. Owner: ${vm.owner.name} (${vm.owner.email})`,
    });
    // Lock the network down before the VM ever boots.
    await applyNetworkPolicy(core, vmId, log);
    log("starting");
    await drv.start(node, vmid);
  } catch (e) {
    await db.vm.update({ where: { id: vmId }, data: { status: "error", error: (e as Error).message } });
    throw e;
  }
  await db.vm.update({ where: { id: vmId }, data: { status: "active", error: "" } });
  log(image.kind === "iso" ? "ready - open the console to run the installer" : "ready");
}

/** Live Proxmox record (node, status) for a portal VM, bypassing the cache. */
export async function locate(core: Core, vm: Pick<Vm, "clusterId" | "vmid">): Promise<PveVm | undefined> {
  if (vm.vmid === null) return undefined;
  return findVm(core.driver(vm.clusterId), vm.vmid);
}

export type PowerAction = "start" | "shutdown" | "stop" | "reboot";

export async function power(core: Core, vmId: string, action: PowerAction, log: Log) {
  const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId } });
  const live = await locate(core, vm);
  if (!live || vm.vmid === null) throw new ProxmoxError(`VM ${vm.vmid} not found on the cluster`);
  const drv = core.driver(vm.clusterId);
  log(`${action} VM ${vm.vmid} on ${live.node}`);
  await drv[action](live.node, vm.vmid);
  log("done");
}

/** End a VM's bookings: future ones are cancelled, a running one is completed. */
export async function closeReservations(vmId: string) {
  await db.reservation.updateMany({ where: { vmId, status: "scheduled" }, data: { status: "cancelled" } });
  await db.reservation.updateMany({ where: { vmId, status: "active" }, data: { status: "completed" } });
}

export async function destroyVm(core: Core, vmId: string, log: Log) {
  const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId } });
  const live = await locate(core, vm);
  if (live && vm.vmid !== null) {
    const drv = core.driver(vm.clusterId);
    if (live.status !== "stopped") {
      log("stopping");
      await drv.stop(live.node, vm.vmid);
    }
    log(`destroying VM ${vm.vmid}`);
    await drv.destroy(live.node, vm.vmid);
  }
  await closeReservations(vmId);
  await db.service.deleteMany({ where: { vmId } });
  await db.vm.update({ where: { id: vmId }, data: { status: "deleted" } });
  log("deleted");
}
