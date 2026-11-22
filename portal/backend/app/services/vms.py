"""VM lifecycle: provision from template, power, destroy."""
from __future__ import annotations

import re
from urllib.parse import quote

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import ClusterConfig
from ..core import Core, Log
from ..db import VM, VM_LIVE, Image, Reservation, Service, User
from . import images
from ..proxmox.base import ProxmoxError, disk_key, disk_size_gb


def tag_safe(value: str) -> str:
    return re.sub(r"[^a-z0-9_.+-]", "-", value.lower()).strip("-") or "unknown"


def usage(db: Session, user_id: int, cluster_id: str) -> dict[str, int]:
    row = db.execute(
        select(func.count(VM.id), func.coalesce(func.sum(VM.cores), 0),
               func.coalesce(func.sum(VM.memory_mb), 0), func.coalesce(func.sum(VM.disk_gb), 0))
        .where(VM.owner_id == user_id, VM.cluster_id == cluster_id, VM.status.in_(VM_LIVE))).one()
    return {"vms": row[0], "cores": int(row[1]), "memory_mb": int(row[2]), "disk_gb": int(row[3])}


def quota_error(cluster: ClusterConfig, used: dict[str, int], cores: int, memory_mb: int, disk_gb: int) -> str | None:
    q = cluster.quota
    checks = [("VMs", used["vms"] + 1, q.max_vms), ("cores", used["cores"] + cores, q.max_cores),
              ("MB of memory", used["memory_mb"] + memory_mb, q.max_memory_mb),
              ("GB of disk", used["disk_gb"] + disk_gb, q.max_disk_gb)]
    for label, want, limit in checks:
        if limit and want > limit:
            return f"over your quota on {cluster.name}: {want} {label} requested in total, limit is {limit}"
    return None


async def _allocate_vmid(core: Core, cluster: ClusterConfig) -> int:
    live = {v["vmid"] for v in await core.driver(cluster.id).vms()}
    with core.Session() as db:
        # Archived VMs keep their id so their backups can never be mistaken for a newer VM's.
        taken = set(db.scalars(select(VM.vmid).where(
            VM.cluster_id == cluster.id, VM.vmid.is_not(None), VM.status != "deleted")))
    lo, hi = cluster.vmid_range
    for vmid in range(lo, hi + 1):
        if vmid not in live and vmid not in taken:
            return vmid
    raise ProxmoxError(f"no free VMID in {lo}-{hi}")


async def _pick_node(core: Core, cluster: ClusterConfig, fallback: str | None) -> str:
    """Emptiest online node on shared storage; otherwise stay where the source is."""
    online = [n for n in await core.driver(cluster.id).nodes() if n["status"] == "online"]
    if not online:
        raise ProxmoxError("no node is online")
    if cluster.shared_storage or fallback is None:
        return max(online, key=lambda n: n["maxmem"] - n["mem"])["node"]
    return fallback


async def _from_template(core: Core, cluster: ClusterConfig, vm: VM, image: Image, log: Log) -> tuple[str, int]:
    drv = core.driver(cluster.id)
    async with core.provision_locks[cluster.id]:
        src = await drv.find_vm(image.vmid)
        if not src:
            raise ProxmoxError(f"template VM {image.vmid} not found on {cluster.name}")
        vmid = await _allocate_vmid(core, cluster)
        node = await _pick_node(core, cluster, src["node"])
        log(f"cloning template {image.name} ({image.vmid}) to VM {vmid} on {node}")
        await drv.clone(src["node"], image.vmid, vmid, vm.name, cluster.storage, target=node)
        with core.Session.begin() as db:
            db.get(VM, vm.id).vmid = vmid

    params: dict = {"cores": vm.cores, "memory": vm.memory_mb, "onboot": 0}
    if cluster.bridge:
        params["net0"] = f"virtio,bridge={cluster.bridge}" + (f",tag={cluster.vlan}" if cluster.vlan else "")
    if image.os == "linux":
        if image.default_user:
            params["ciuser"] = image.default_user
        params["ipconfig0"] = "ip=dhcp"
        if vm.ssh_public_key.strip():
            # Proxmox wants this value URL-encoded on top of the form encoding.
            params["sshkeys"] = quote(vm.ssh_public_key.strip(), safe="")
    if image.cicustom:
        params["cicustom"] = image.cicustom
    log(f"configuring {vm.cores} cores, {vm.memory_mb} MB")
    await drv.set_config(node, vmid, **params)

    config = await drv.vm_config(node, vmid)
    disk = disk_key(config)
    if disk and disk_size_gb(str(config[disk])) < vm.disk_gb:
        log(f"growing {disk} to {vm.disk_gb} GB")
        await drv.resize_disk(node, vmid, disk, vm.disk_gb)
    return node, vmid


async def _from_iso(core: Core, cluster: ClusterConfig, vm: VM, image: Image, log: Log) -> tuple[str, int]:
    """A blank UEFI/q35 VM (so a GPU can be passed through later) booting the installer."""
    drv = core.driver(cluster.id)
    storage = image.volid.split(":")[0]
    async with core.provision_locks[cluster.id]:
        node = await _pick_node(core, cluster, None)
        # ISO storage may be node-local: go where the file is.
        if not any(v["volid"] == image.volid for v in await drv.storage_content(node, storage, "iso")):
            for n in await drv.nodes():
                if n["status"] == "online" and any(
                        v["volid"] == image.volid for v in await drv.storage_content(n["node"], storage, "iso")):
                    node = n["node"]
                    break
            else:
                raise ProxmoxError(f"ISO {image.volid} not found on any node")
        vmid = await _allocate_vmid(core, cluster)
        windows = image.os == "windows"
        # Windows setup has no virtio drivers, so give it SATA + e1000.
        nic = ("e1000" if windows else "virtio") + f",bridge={cluster.bridge or 'vmbr0'}" \
            + (f",tag={cluster.vlan}" if cluster.vlan else "")
        disk = "sata0" if windows else "scsi0"
        params = {
            "name": vm.name, "cores": vm.cores, "memory": vm.memory_mb, "cpu": "host", "onboot": 0, "agent": 1,
            "machine": "q35", "bios": "ovmf", "efidisk0": f"{cluster.storage}:1,efitype=4m,pre-enrolled-keys=0",
            "scsihw": "virtio-scsi-single", disk: f"{cluster.storage}:{vm.disk_gb}",
            "ide2": f"{image.volid},media=cdrom", "boot": f"order={disk};ide2", "net0": nic,
            "ostype": "win11" if windows else "l26" if image.os == "linux" else "other",
        }
        if windows:
            params["tpmstate0"] = f"{cluster.storage}:1,version=v2.0"
        log(f"creating VM {vmid} on {node} with installer {image.name}")
        await drv.create_vm(node, vmid, **params)
        with core.Session.begin() as db:
            db.get(VM, vm.id).vmid = vmid
    return node, vmid


async def provision(core: Core, vm_id: int, log: Log) -> None:
    from . import network  # avoid an import cycle

    with core.Session() as db:
        vm = db.get(VM, vm_id)
        owner = vm.owner
        image = images.get(db, vm.cluster_id, vm.template_id)
    cluster = core.cluster(vm.cluster_id)
    drv = core.driver(cluster.id)
    try:
        if not image:
            raise ProxmoxError(f"image {vm.template_id} is no longer in the library")
        node, vmid = await (_from_iso if image.kind == "iso" else _from_template)(core, cluster, vm, image, log)
        await drv.set_config(node, vmid, tags=f"macs;owner-{tag_safe(owner.username)}",
                             description=f"Managed by the MACS portal. Owner: {owner.username} ({owner.email})")
        # Lock the network down before the VM ever boots.
        await network.apply(core, vm_id, log)
        log("starting")
        await drv.start(node, vmid)
    except Exception as e:
        with core.Session.begin() as db:
            row = db.get(VM, vm_id)
            row.status, row.error = "error", str(e)
        raise
    with core.Session.begin() as db:
        row = db.get(VM, vm_id)
        row.status, row.error = "active", ""
    log("ready - open the console to run the installer" if image.kind == "iso" else "ready")


async def locate(core: Core, vm: VM) -> dict | None:
    """Live Proxmox record (node, status) for a portal VM, bypassing the cache."""
    if vm.vmid is None:
        return None
    return await core.driver(vm.cluster_id).find_vm(vm.vmid)


async def power(core: Core, vm_id: int, action: str, log: Log) -> None:
    with core.Session() as db:
        vm = db.get(VM, vm_id)
    live = await locate(core, vm)
    if not live:
        raise ProxmoxError(f"VM {vm.vmid} not found on the cluster")
    drv = core.driver(vm.cluster_id)
    log(f"{action} VM {vm.vmid} on {live['node']}")
    if action == "start":
        await drv.start(live["node"], vm.vmid)
    elif action == "shutdown":
        await drv.shutdown(live["node"], vm.vmid)
    elif action == "stop":
        await drv.stop(live["node"], vm.vmid)
    elif action == "reboot":
        await drv.reboot(live["node"], vm.vmid)
    else:
        raise ValueError(f"unknown action {action}")
    log("done")


def close_reservations(db: Session, vm_id: int) -> None:
    for r in db.scalars(select(Reservation).where(
            Reservation.vm_id == vm_id, Reservation.status.in_(("scheduled", "active")))):
        r.status = "cancelled" if r.status == "scheduled" else "completed"


async def destroy(core: Core, vm_id: int, log: Log) -> None:
    with core.Session() as db:
        vm = db.get(VM, vm_id)
    live = await locate(core, vm)
    if live:
        drv = core.driver(vm.cluster_id)
        if live["status"] != "stopped":
            log("stopping")
            await drv.stop(live["node"], vm.vmid)
        log(f"destroying VM {vm.vmid}")
        await drv.delete(live["node"], vm.vmid)
    with core.Session.begin() as db:
        close_reservations(db, vm_id)
        for svc in db.scalars(select(Service).where(Service.vm_id == vm_id)):
            db.delete(svc)
        db.get(VM, vm_id).status = "deleted"
    log("deleted")


def find_user(db: Session, username: str) -> User | None:
    return db.scalar(select(User).where(User.username == username))
