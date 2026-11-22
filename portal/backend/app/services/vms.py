"""VM lifecycle: provision from template, power, destroy."""
from __future__ import annotations

import re
from urllib.parse import quote

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import ClusterConfig
from ..core import Core, Log
from ..db import VM, VM_LIVE, Reservation, User
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


async def provision(core: Core, vm_id: int, log: Log) -> None:
    with core.Session() as db:
        vm = db.get(VM, vm_id)
        owner = vm.owner
    cluster = core.cluster(vm.cluster_id)
    drv = core.driver(cluster.id)
    try:
        tpl = cluster.template(vm.template_id)
        if not tpl:
            raise ProxmoxError(f"template {vm.template_id} is no longer configured")
        async with core.provision_locks[cluster.id]:
            live = await drv.vms()
            src = next((v for v in live if v["vmid"] == tpl.vmid), None)
            if not src:
                raise ProxmoxError(f"template VM {tpl.vmid} not found on {cluster.name}")
            vmid = await _allocate_vmid(core, cluster)
            node = src["node"]
            if cluster.shared_storage:
                online = [n for n in await drv.nodes() if n["status"] == "online"]
                if online:
                    node = max(online, key=lambda n: n["maxmem"] - n["mem"])["node"]
            log(f"cloning template {tpl.name} ({tpl.vmid}) to VM {vmid} on {node}")
            await drv.clone(src["node"], tpl.vmid, vmid, vm.name, cluster.storage, target=node)
            with core.Session.begin() as db:
                db.get(VM, vm_id).vmid = vmid

        params: dict = {
            "cores": vm.cores, "memory": vm.memory_mb, "onboot": 0,
            "tags": f"macs;owner-{tag_safe(owner.username)}",
            "description": f"Managed by the MACS portal. Owner: {owner.username} ({owner.email})",
        }
        if cluster.bridge:
            params["net0"] = f"virtio,bridge={cluster.bridge}" + (f",tag={cluster.vlan}" if cluster.vlan else "")
        if tpl.os == "linux":
            params["ciuser"] = tpl.default_user
            params["ipconfig0"] = "ip=dhcp"
            if vm.ssh_public_key.strip():
                # Proxmox wants this value URL-encoded on top of the form encoding.
                params["sshkeys"] = quote(vm.ssh_public_key.strip(), safe="")
        if tpl.cicustom:
            params["cicustom"] = tpl.cicustom
        log(f"configuring {vm.cores} cores, {vm.memory_mb} MB")
        await drv.set_config(node, vmid, **params)

        config = await drv.vm_config(node, vmid)
        disk = disk_key(config)
        if disk and disk_size_gb(str(config[disk])) < vm.disk_gb:
            log(f"growing {disk} to {vm.disk_gb} GB")
            await drv.resize_disk(node, vmid, disk, vm.disk_gb)

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
    log("ready")


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
        db.get(VM, vm_id).status = "deleted"
    log("deleted")


def find_user(db: Session, username: str) -> User | None:
    return db.scalar(select(User).where(User.username == username))
