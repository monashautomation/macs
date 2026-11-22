"""In-memory Proxmox stand-in for local development and tests.

It enforces the constraints that matter for GPU orchestration (a passthrough
device can back one running VM, raw PCI ids are node-local, VMs with hostpci
cannot migrate) so the portal's logic is exercised realistically.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

from ..config import ClusterConfig
from .base import ProxmoxDriver, ProxmoxError, hostpci_entries


class MockProxmox(ProxmoxDriver):
    def __init__(self, cfg: ClusterConfig, delay: float = 0.0, demo: bool = False):
        self.cfg = cfg
        self.delay = delay
        self.node_names = sorted({d.node for d in cfg.gpu.devices}) or ["pve1", "pve2", "pve3"]
        self.guests: dict[int, dict[str, Any]] = {}
        self.backup_store: list[dict[str, Any]] = []
        if cfg.mock_state_file and os.path.exists(cfg.mock_state_file):
            with open(cfg.mock_state_file) as fh:
                state = json.load(fh)
            self.guests = {int(k): v for k, v in state["guests"].items()}
            self.backup_store = state["backups"]
        else:
            for t in cfg.templates:
                self.guests[t.vmid] = self._guest(t.vmid, t.id, self.node_names[0], template=True,
                                                  config={"cores": 2, "memory": 2048, "scsi0": f"{cfg.storage}:base-{t.vmid}-disk-0,size=20G"})
            if demo and cfg.gpu.devices:
                # Something for the "unmanaged VM holding a GPU" paths to chew on.
                d = cfg.gpu.devices[-1]
                value = f"mapping={cfg.gpu.mapping}" if cfg.gpu.mapping else d.pci
                self.seed_vm(cfg.vmid_range[0] - 1, "legacy-sim-box", d.node, running=True, hostpci0=f"{value},pcie=1")
            self._save()

    def _guest(self, vmid: int, name: str, node: str, template: bool = False, config: dict | None = None) -> dict:
        return {"vmid": vmid, "name": name, "node": node, "status": "stopped", "template": template,
                "config": {"name": name, **(config or {})}, "started": 0.0}

    def _save(self) -> None:
        if self.cfg.mock_state_file:
            with open(self.cfg.mock_state_file, "w") as fh:
                json.dump({"guests": self.guests, "backups": self.backup_store}, fh)

    async def _work(self) -> None:
        if self.delay:
            await asyncio.sleep(self.delay)

    def _get(self, node: str, vmid: int) -> dict:
        g = self.guests.get(vmid)
        if not g:
            raise ProxmoxError(f"VM {vmid} does not exist")
        if g["node"] != node:
            raise ProxmoxError(f"VM {vmid} is not on node {node}")
        return g

    def seed_vm(self, vmid: int, name: str, node: str, running: bool = False, **config: Any) -> None:
        g = self._guest(vmid, name, node, config={"cores": 4, "memory": 8192,
                                                  "scsi0": f"{self.cfg.storage}:vm-{vmid}-disk-0,size=40G", **config})
        g["status"] = "running" if running else "stopped"
        g["started"] = time.time() if running else 0.0
        self.guests[vmid] = g
        self._save()

    # -- inventory -------------------------------------------------------

    async def nodes(self):
        out = []
        for n in self.node_names:
            running = [g for g in self.guests.values() if g["node"] == n and g["status"] == "running"]
            out.append({"node": n, "status": "online",
                        "cpu": min(0.95, sum(g["config"].get("cores", 1) for g in running) / 64), "maxcpu": 64,
                        "mem": sum(g["config"].get("memory", 0) for g in running) * 1024 * 1024,
                        "maxmem": 256 * 1024 ** 3})
        return out

    async def vms(self):
        return [{"vmid": g["vmid"], "name": g["name"], "node": g["node"], "status": g["status"],
                 "template": g["template"], "tags": g["config"].get("tags", ""),
                 "cpu": 0.07 if g["status"] == "running" else 0, "maxcpu": g["config"].get("cores", 1),
                 "mem": g["config"].get("memory", 0) * 1024 * 1024 * (0.4 if g["status"] == "running" else 0),
                 "maxmem": g["config"].get("memory", 0) * 1024 * 1024,
                 "uptime": int(time.time() - g["started"]) if g["status"] == "running" else 0}
                for g in self.guests.values()]

    async def vm_config(self, node, vmid):
        return dict(self._get(node, vmid)["config"])

    async def set_config(self, node, vmid, **params):
        g = self._get(node, vmid)
        for key in str(params.pop("delete", "") or "").split(","):
            g["config"].pop(key.strip(), None)
        g["config"].update({k: v for k, v in params.items() if v is not None})
        if "name" in params:
            g["name"] = params["name"]
        self._save()

    # -- lifecycle -------------------------------------------------------

    async def clone(self, node, template_vmid, newid, name, storage, target=None):
        src = self._get(node, template_vmid)
        if newid in self.guests:
            raise ProxmoxError(f"VM {newid} already exists")
        await self._work()
        cfg = {k: v for k, v in src["config"].items() if k != "name"}
        cfg["scsi0"] = f"{storage}:vm-{newid}-disk-0,size=20G"
        self.guests[newid] = self._guest(newid, name, target or node, config=cfg)
        self._save()

    async def resize_disk(self, node, vmid, disk, size_gb):
        g = self._get(node, vmid)
        g["config"][disk] = g["config"][disk].rsplit(",size=", 1)[0] + f",size={size_gb}G"
        self._save()

    def _check_passthrough(self, g: dict) -> None:
        for value in hostpci_entries(g["config"]).values():
            on_node = [d for d in self.cfg.gpu.devices if d.node == g["node"]]
            busy = sum(len(hostpci_entries(o["config"])) for o in self.guests.values()
                       if o is not g and o["node"] == g["node"] and o["status"] == "running")
            if value.startswith("mapping="):
                if not on_node:
                    raise ProxmoxError(f"start failed: PCI mapping has no device on node {g['node']}")
            elif not any(value.split(",")[0] == d.pci for d in on_node):
                raise ProxmoxError(f"start failed: no PCI device {value.split(',')[0]} on node {g['node']}")
            if busy >= len(on_node):
                raise ProxmoxError("start failed: PCI device is already in use by another VM")

    async def start(self, node, vmid):
        g = self._get(node, vmid)
        if g["template"]:
            raise ProxmoxError("cannot start a template")
        if g["status"] != "running":
            self._check_passthrough(g)
            await self._work()
            g["status"], g["started"] = "running", time.time()
            self._save()

    async def shutdown(self, node, vmid, timeout=120):
        await self.stop(node, vmid)

    async def stop(self, node, vmid):
        g = self._get(node, vmid)
        if g["status"] != "stopped":
            await self._work()
            g["status"] = "stopped"
            self._save()

    async def reboot(self, node, vmid):
        g = self._get(node, vmid)
        if g["status"] != "running":
            raise ProxmoxError(f"VM {vmid} not running")
        await self._work()
        g["started"] = time.time()

    async def migrate(self, node, vmid, target):
        g = self._get(node, vmid)
        if target not in self.node_names:
            raise ProxmoxError(f"no such node {target}")
        if g["status"] == "running":
            raise ProxmoxError("mock only supports offline migration")
        await self._work()
        g["node"] = target
        self._save()

    async def delete(self, node, vmid):
        g = self._get(node, vmid)
        if g["status"] == "running":
            raise ProxmoxError(f"VM {vmid} is running - destroy failed")
        del self.guests[vmid]
        self._save()

    async def vm_ips(self, node, vmid):
        g = self._get(node, vmid)
        return [f"10.20.{vmid // 256}.{vmid % 256}"] if g["status"] == "running" else []

    # -- backups ---------------------------------------------------------

    async def backups(self, node, storage, vmid):
        return [{k: b[k] for k in ("volid", "ctime", "size", "notes")}
                for b in self.backup_store if b["vmid"] == vmid and b["storage"] == storage]

    async def backup(self, node, vmid, storage, notes="", mode="snapshot"):
        g = self._get(node, vmid)
        await self._work()
        now = int(time.time())
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        volid = f"{storage}:backup/vm/{vmid}/{stamp}"
        n = 1
        while any(b["volid"] == volid for b in self.backup_store):
            n += 1
            volid = f"{storage}:backup/vm/{vmid}/{stamp}-{n}"
        entry = {"volid": volid, "ctime": now, "size": 12 * 1024 ** 3, "notes": notes, "vmid": vmid,
                 "storage": storage, "guest": json.loads(json.dumps(g))}
        self.backup_store.append(entry)
        self._save()
        return {k: entry[k] for k in ("volid", "ctime", "size", "notes")}

    async def restore(self, node, vmid, volid, storage, force=False):
        b = next((b for b in self.backup_store if b["volid"] == volid), None)
        if not b:
            raise ProxmoxError(f"no such backup {volid}")
        existing = self.guests.get(vmid)
        if existing and not force:
            raise ProxmoxError(f"VM {vmid} already exists")
        if existing and existing["status"] == "running":
            raise ProxmoxError(f"VM {vmid} is running")
        await self._work()
        g = json.loads(json.dumps(b["guest"]))
        g.update(vmid=vmid, node=node, status="stopped")
        self.guests[vmid] = g
        self._save()
