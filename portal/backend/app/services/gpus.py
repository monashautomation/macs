"""GPU passthrough tracking and swapping.

Who holds a GPU is always read from the VMs' Proxmox config (hostpciN), so the
view is correct even for VMs changed outside the portal.
"""
from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy import select

from ..config import ClusterConfig
from ..core import Core, Log
from ..db import VM, Reservation
from ..proxmox.base import ProxmoxError, free_hostpci_key, hostpci_entries


def _norm_pci(addr: str) -> str:
    """'0000:01:00.0' / '01:00' -> '01:00' (domain 0, function dropped)."""
    addr = addr.strip().lower().split(".")[0]
    return addr[5:] if addr.startswith("0000:") else addr


async def gpu_state(core: Core, cluster: ClusterConfig, fresh: bool = False) -> list[dict[str, Any]]:
    """One entry per configured GPU with its current holder (or None)."""
    if fresh:
        core.invalidate(cluster.id)

    async def fetch() -> list[dict[str, Any]]:
        drv = core.driver(cluster.id)
        guests = [v for v in await drv.vms() if not v["template"]]
        sem = asyncio.Semaphore(8)

        async def cfg(v):
            async with sem:
                try:
                    return v, hostpci_entries(await drv.vm_config(v["node"], v["vmid"]))
                except ProxmoxError:
                    return v, {}  # VM vanished or moved mid-scan

        scanned = await asyncio.gather(*(cfg(v) for v in guests))
        state = [{"id": d.id, "node": d.node, "model": d.model, "pci": d.pci, "holder": None}
                 for d in cluster.gpu.devices]

        def hold(gpu: dict, v: dict, key: str) -> None:
            gpu["holder"] = {"vmid": v["vmid"], "name": v["name"], "status": v["status"], "key": key}

        mapped: list[tuple[dict, str]] = []
        for v, entries in scanned:
            for key, value in entries.items():
                first = value.split(",")[0]
                if first.startswith("mapping="):
                    if cluster.gpu.mapping and first == f"mapping={cluster.gpu.mapping}":
                        mapped.append((v, key))
                    continue
                for gpu in state:
                    if gpu["node"] == v["node"] and gpu["pci"] and not gpu["holder"] \
                            and _norm_pci(gpu["pci"]) == _norm_pci(first):
                        hold(gpu, v, key)
                        break
        # A mapping resolves to whichever device is free on the VM's node; running VMs claim first.
        for v, key in sorted(mapped, key=lambda m: m[0]["status"] != "running"):
            gpu = next((g for g in state if g["node"] == v["node"] and not g["holder"]), None)
            if gpu:
                hold(gpu, v, key)
        return state

    return await core.cached((cluster.id, "gpus"), fetch)


def _hostpci_value(cluster: ClusterConfig, gpu: dict) -> str:
    device = f"mapping={cluster.gpu.mapping}" if cluster.gpu.mapping else gpu["pci"]
    return f"{device},{cluster.gpu.hostpci_opts}" if cluster.gpu.hostpci_opts else device


def _reserved_vmids(core: Core, cluster_id: str) -> set[int]:
    """VMIDs whose GPU must not be taken automatically: an active booking."""
    with core.Session() as db:
        return set(db.scalars(select(VM.vmid).join(Reservation, Reservation.vm_id == VM.id).where(
            VM.cluster_id == cluster_id, Reservation.status == "active", VM.vmid.is_not(None))))


def _managed_vmids(core: Core, cluster_id: str) -> set[int]:
    with core.Session() as db:
        return set(db.scalars(select(VM.vmid).where(
            VM.cluster_id == cluster_id, VM.status == "active", VM.vmid.is_not(None))))


async def _strip(core: Core, cluster: ClusterConfig, holder: dict, node: str, log: Log, restart: bool) -> None:
    drv = core.driver(cluster.id)
    was_running = holder["status"] != "stopped"
    if was_running:
        log(f"shutting down {holder['name']} ({holder['vmid']})")
        await drv.shutdown(node, holder["vmid"], cluster.gpu.shutdown_timeout_seconds)
    log(f"detaching GPU from {holder['name']} ({holder['vmid']})")
    await drv.set_config(node, holder["vmid"], delete=holder["key"])
    if was_running and restart:
        log(f"restarting {holder['name']} without a GPU")
        await drv.start(node, holder["vmid"])


async def attach(core: Core, cluster: ClusterConfig, vmid: int, log: Log,
                 gpu_id: str | None = None, preempt: bool = False) -> str:
    """Give `vmid` a GPU and boot it. Returns the GPU id.

    gpu_id given: take exactly that GPU, evicting whoever holds it (admin swap).
    Otherwise pick a free GPU, preferring the VM's current node; with `preempt`,
    fall back to a GPU held by a portal VM that has no active booking.
    """
    drv = core.driver(cluster.id)
    async with core.gpu_locks[cluster.id]:
        state = await gpu_state(core, cluster, fresh=True)
        target = await drv.find_vm(vmid)
        if not target:
            raise ProxmoxError(f"VM {vmid} not found on {cluster.name}")
        mine = next((g for g in state if g["holder"] and g["holder"]["vmid"] == vmid), None)

        if gpu_id:
            gpu = next((g for g in state if g["id"] == gpu_id), None)
            if not gpu:
                raise ProxmoxError(f"unknown GPU {gpu_id}")
        elif mine:
            gpu = mine
        else:
            free = [g for g in state if not g["holder"]]
            if not free and preempt:
                reserved, managed = _reserved_vmids(core, cluster.id), _managed_vmids(core, cluster.id)
                free = [g for g in state if g["holder"]["vmid"] in managed and g["holder"]["vmid"] not in reserved]
            if not free:
                raise ProxmoxError("no GPU is free right now")
            gpu = min(free, key=lambda g: (g["node"] != target["node"], g["holder"] is not None))

        if mine and mine["id"] == gpu["id"]:
            if target["status"] != "running":
                log(f"{target['name']} already has {gpu['id']}; starting it")
                await drv.start(target["node"], vmid)
            else:
                log(f"{target['name']} already has {gpu['id']}")
            return gpu["id"]

        if gpu["node"] != target["node"] and not cluster.shared_storage:
            raise ProxmoxError(f"{gpu['id']} is on {gpu['node']} but {target['name']} is on {target['node']}, "
                               "and this cluster has no shared storage to migrate with")

        try:
            if gpu["holder"]:
                await _strip(core, cluster, gpu["holder"], gpu["node"], log, restart=True)
            if target["status"] != "stopped":
                log(f"shutting down {target['name']} ({vmid})")
                await drv.shutdown(target["node"], vmid, cluster.gpu.shutdown_timeout_seconds)
            if mine:
                log(f"detaching {mine['id']} from {target['name']}")
                await drv.set_config(target["node"], vmid, delete=mine["holder"]["key"])
            if gpu["node"] != target["node"]:
                log(f"migrating {target['name']} from {target['node']} to {gpu['node']}")
                await drv.migrate(target["node"], vmid, gpu["node"])
            key = free_hostpci_key(await drv.vm_config(gpu["node"], vmid))
            log(f"attaching {gpu['id']} ({gpu['model']}) to {target['name']} as {key}")
            await drv.set_config(gpu["node"], vmid, **{key: _hostpci_value(cluster, gpu)})
            log(f"starting {target['name']}")
            await drv.start(gpu["node"], vmid)
        finally:
            core.invalidate(cluster.id)
        return gpu["id"]


async def detach(core: Core, cluster: ClusterConfig, vmid: int, log: Log, restart: bool = True) -> bool:
    """Remove any pool GPU from `vmid`. Returns False if it held none."""
    async with core.gpu_locks[cluster.id]:
        state = await gpu_state(core, cluster, fresh=True)
        held = [g for g in state if g["holder"] and g["holder"]["vmid"] == vmid]
        if not held:
            log("no GPU attached")
            return False
        try:
            for i, gpu in enumerate(held):
                # Only the first strip needs the shutdown; refresh status for the rest.
                holder = dict(gpu["holder"], status=gpu["holder"]["status"] if i == 0 else "stopped")
                await _strip(core, cluster, holder, gpu["node"], log, restart=False)
            if restart and held[0]["holder"]["status"] != "stopped":
                log("restarting without a GPU")
                await core.driver(cluster.id).start(held[0]["node"], vmid)
        finally:
            core.invalidate(cluster.id)
        return True
