"""Backups to Proxmox Backup Server, plus archive (backup + destroy) and restore."""
from __future__ import annotations

from datetime import datetime, timezone

from ..core import Core, Log
from ..db import VM, Backup
from ..proxmox.base import ProxmoxError, hostpci_entries
from . import gpus
from .vms import close_reservations, locate


def _record(core: Core, vm_id: int, entry: dict, notes: str) -> None:
    with core.Session.begin() as db:
        db.add(Backup(vm_id=vm_id, volid=entry["volid"], notes=notes, size=int(entry.get("size") or 0),
                      created_at=datetime.fromtimestamp(entry["ctime"], timezone.utc).replace(tzinfo=None)))


def _load(core: Core, vm_id: int) -> VM:
    with core.Session() as db:
        return db.get(VM, vm_id)


async def backup(core: Core, vm_id: int, notes: str, log: Log) -> None:
    vm = _load(core, vm_id)
    cluster = core.cluster(vm.cluster_id)
    live = await locate(core, vm)
    if not live:
        raise ProxmoxError(f"VM {vm.vmid} not found on the cluster")
    log(f"backing up VM {vm.vmid} to {cluster.backup_storage}")
    entry = await core.driver(cluster.id).backup(live["node"], vm.vmid, cluster.backup_storage, notes or vm.name)
    _record(core, vm_id, entry, notes)
    log(f"backup complete: {entry['volid']}")


async def archive(core: Core, vm_id: int, log: Log) -> None:
    """Shut the VM down, back it up, then destroy it to free cluster resources."""
    vm = _load(core, vm_id)
    cluster = core.cluster(vm.cluster_id)
    drv = core.driver(cluster.id)
    live = await locate(core, vm)
    if not live:
        raise ProxmoxError(f"VM {vm.vmid} not found on the cluster")
    with core.Session.begin() as db:
        close_reservations(db, vm_id)
    if cluster.has_gpus:
        # Never bake a passthrough device into an archive.
        await gpus.detach(core, cluster, vm.vmid, log, restart=False)
        live = await locate(core, vm)
    if live["status"] != "stopped":
        log("shutting down")
        await drv.shutdown(live["node"], vm.vmid)
    log(f"backing up VM {vm.vmid} to {cluster.backup_storage}")
    notes = f"archive of {vm.name}"
    entry = await drv.backup(live["node"], vm.vmid, cluster.backup_storage, notes, mode="stop")
    _record(core, vm_id, entry, notes)
    log(f"backup complete: {entry['volid']}; destroying VM {vm.vmid}")
    await drv.delete(live["node"], vm.vmid)
    with core.Session.begin() as db:
        row = db.get(VM, vm_id)
        row.status, row.archive_volid = "archived", entry["volid"]
    core.scheduler_kick.set()
    log("archived")


async def restore(core: Core, vm_id: int, volid: str, log: Log) -> None:
    """Restore a backup: recreates an archived VM, or rolls an existing one back."""
    vm = _load(core, vm_id)
    cluster = core.cluster(vm.cluster_id)
    drv = core.driver(cluster.id)
    live = await locate(core, vm)
    if vm.status == "archived":
        if live:
            raise ProxmoxError(f"VMID {vm.vmid} is in use on the cluster; an admin needs to free it first")
        online = [n for n in await drv.nodes() if n["status"] == "online"]
        if not online:
            raise ProxmoxError("no node is online")
        node = max(online, key=lambda n: n["maxmem"] - n["mem"])["node"]
        log(f"restoring {volid} to VM {vm.vmid} on {node}")
        await drv.restore(node, vm.vmid, volid, cluster.storage)
        keep: dict[str, str] = {}
    else:
        if not live:
            raise ProxmoxError(f"VM {vm.vmid} not found on the cluster")
        node = live["node"]
        keep = hostpci_entries(await drv.vm_config(node, vm.vmid))
        if live["status"] != "stopped":
            log("shutting down")
            await drv.shutdown(node, vm.vmid)
        log(f"rolling VM {vm.vmid} back to {volid}")
        await drv.restore(node, vm.vmid, volid, cluster.storage, force=True)

    # The backup carries the config from when it was taken; passthrough must
    # reflect today's GPU assignment instead.
    stale = hostpci_entries(await drv.vm_config(node, vm.vmid))
    if stale != keep:
        if stale:
            await drv.set_config(node, vm.vmid, delete=",".join(stale))
        if keep:
            await drv.set_config(node, vm.vmid, **keep)
    core.invalidate(cluster.id)
    log("starting")
    await drv.start(node, vm.vmid)
    with core.Session.begin() as db:
        row = db.get(VM, vm_id)
        row.status, row.archive_volid, row.error = "active", "", ""
    log("restored")
