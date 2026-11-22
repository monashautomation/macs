"""In-memory Proxmox stand-in for local development and tests.

It enforces the constraints that matter for GPU orchestration (a passthrough
device can back one running VM, raw PCI ids are node-local, VMs with hostpci
cannot migrate) so the portal's logic is exercised realistically.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import struct
import time
from typing import Any

from ..config import ClusterConfig
from .base import ConsoleStream, ProxmoxDriver, ProxmoxError, hostpci_entries


class MockConsole(ConsoleStream):
    """A tiny RFB 3.8 server: one static screen, plus a block drawn per key
    press so input can be seen to arrive. Enough for a real noVNC client."""

    WIDTH, HEIGHT = 800, 450

    def __init__(self, name: str):
        self.password = "mock"
        self.name = name
        self.keys = 0
        self._in = asyncio.StreamReader()
        self._out: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._task = asyncio.get_running_loop().create_task(self._serve())

    async def recv(self):
        return await self._out.get()

    async def send(self, data):
        self._in.feed_data(data)

    async def close(self):
        self._task.cancel()
        self._out.put_nowait(None)

    def _rect(self, x: int, y: int, w: int, h: int, rgb: tuple[int, int, int], shifts: tuple[int, int, int]) -> bytes:
        pixel = struct.pack("<I", sum(c << s for c, s in zip(rgb, shifts)))
        return struct.pack(">HHHHi", x, y, w, h, 0) + pixel * (w * h)

    async def _serve(self) -> None:
        r, put = self._in, self._out.put_nowait
        try:
            put(b"RFB 003.008\n")
            await r.readexactly(12)
            put(bytes([1, 1]))                       # one security type: None
            await r.readexactly(1)
            put(struct.pack(">I", 0))                # SecurityResult OK
            await r.readexactly(1)                   # ClientInit
            title = f"{self.name} (mock console)".encode()
            put(struct.pack(">HHBBBBHHHBBBxxxI", self.WIDTH, self.HEIGHT, 32, 24, 0, 1, 255, 255, 255, 16, 8, 0,
                            len(title)) + title)
            shifts, drawn, painted, waiting = (16, 8, 0), 0, False, False

            def flush(full: bool) -> bool:
                """Send whatever changed; like a real server, stay silent if nothing did."""
                nonlocal drawn, painted
                rects = []
                if full or not painted:
                    painted, drawn = True, 0
                    rects.append(self._rect(0, 0, self.WIDTH, self.HEIGHT, (16, 20, 28), shifts))
                    rects += [self._rect(24, 28 + 22 * i, w, 10, (90, 200, 130), shifts)
                              for i, w in enumerate((260, 420, 180))]
                while drawn < self.keys:
                    rects.append(self._rect(24 + 12 * (drawn % 60), 110 + 22 * (drawn // 60), 9, 14,
                                            (230, 230, 230), shifts))
                    drawn += 1
                if rects:
                    put(struct.pack(">BxH", 0, len(rects)) + b"".join(rects))
                return bool(rects)

            while True:
                kind = (await r.readexactly(1))[0]
                if kind == 0:                        # SetPixelFormat
                    fmt = await r.readexactly(19)
                    shifts = (fmt[13], fmt[14], fmt[15])
                elif kind == 2:                      # SetEncodings
                    (count,) = struct.unpack(">xH", await r.readexactly(3))
                    await r.readexactly(4 * count)
                elif kind == 3:                      # FramebufferUpdateRequest
                    incremental = (await r.readexactly(9))[0]
                    waiting = not flush(full=not incremental)
                elif kind == 4:                      # KeyEvent
                    self.keys += (await r.readexactly(7))[0]
                    if waiting:                      # answer the request the viewer left open
                        waiting = not flush(full=False)
                elif kind == 5:                      # PointerEvent
                    await r.readexactly(5)
                elif kind == 6:                      # ClientCutText
                    (length,) = struct.unpack(">xxxI", await r.readexactly(7))
                    await r.readexactly(length)
                else:
                    break
        except (asyncio.IncompleteReadError, asyncio.CancelledError):
            pass
        put(None)


class MockProxmox(ProxmoxDriver):
    def __init__(self, cfg: ClusterConfig, delay: float = 0.0, demo: bool = False):
        self.cfg = cfg
        self.delay = delay
        self.node_names = sorted({d.node for d in cfg.gpu.devices}) or ["pve1", "pve2", "pve3"]
        self.guests: dict[int, dict[str, Any]] = {}
        self.backup_store: list[dict[str, Any]] = []
        self.consoles: list[MockConsole] = []
        self.datacenter_firewall = True
        self.isos = [{"volid": f"{cfg.iso_storage}:iso/{name}", "size": size * 1024 ** 2} for name, size in (
            ("debian-12.8.0-amd64-netinst.iso", 631), ("ubuntu-24.04.1-live-server-amd64.iso", 2640),
            ("nixos-minimal-24.11-x86_64-linux.iso", 1105), ("Win11_24H2_English_x64.iso", 5550))
        ] if cfg.iso_storage else []
        if cfg.mock_state_file and os.path.exists(cfg.mock_state_file):
            with open(cfg.mock_state_file) as fh:
                state = json.load(fh)
            self.guests = {int(k): v for k, v in state["guests"].items()}
            self.backup_store = state["backups"]
        else:
            for t in (t for t in cfg.templates if t.kind == "template"):
                self.guests[t.vmid] = self._guest(t.vmid, t.id, self.node_names[0], template=True,
                                                  config={"cores": 2, "memory": 2048, "net0": "virtio=BC:24:11:00:00:01,bridge=vmbr0",
                                                          "scsi0": f"{cfg.storage}:base-{t.vmid}-disk-0,size=20G"})
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

    # -- blank VMs, storage, firewall ------------------------------------

    async def create_vm(self, node, vmid, **params):
        if vmid in self.guests:
            raise ProxmoxError(f"VM {vmid} already exists")
        if node not in self.node_names:
            raise ProxmoxError(f"no such node {node}")
        await self._work()
        name = params.pop("name", f"vm-{vmid}")
        # Like Proxmox, "storage:40" allocates a 40G volume.
        config = {k: (f"{v.split(':')[0]}:vm-{vmid}-disk-0,size={v.split(':')[1].split(',')[0]}G"
                      if k in ("scsi0", "sata0") else v) for k, v in params.items()}
        self.guests[vmid] = self._guest(vmid, name, node, config=config)
        self._save()

    async def storage_content(self, node, storage, content):
        return [dict(i) for i in self.isos] if content == "iso" and storage == self.cfg.iso_storage else []

    def _fw(self, node, vmid) -> dict:
        return self._get(node, vmid).setdefault("firewall", {"options": {}, "rules": []})

    async def firewall_set_options(self, node, vmid, **options):
        self._fw(node, vmid)["options"].update(options)
        self._save()

    async def firewall_rules(self, node, vmid):
        return [{**r, "pos": i} for i, r in enumerate(self._fw(node, vmid)["rules"])]

    async def firewall_add_rule(self, node, vmid, **rule):
        self._fw(node, vmid)["rules"].insert(0, {k: v for k, v in rule.items() if v is not None})
        self._save()

    async def firewall_delete_rule(self, node, vmid, pos):
        del self._fw(node, vmid)["rules"][pos]
        self._save()

    async def cluster_firewall_enabled(self):
        return self.datacenter_firewall

    def reachable(self, vmid: int, source: str, port: int, proto: str = "tcp") -> bool:
        """Would a packet from `source` to this VM's port get through its firewall?"""
        g = self.guests[vmid]
        fw = g.get("firewall", {"options": {}, "rules": []})
        nics = [str(v) for k, v in g["config"].items() if k.startswith("net")]
        if not (self.datacenter_firewall and fw["options"].get("enable") and all("firewall=1" in n for n in nics)):
            return True
        src = ipaddress.ip_address(source)
        for r in fw["rules"]:
            if r.get("type") != "in" or r.get("proto", proto) != proto:
                continue
            if "dport" in r and str(r["dport"]) != str(port):
                continue
            if "source" in r and not any(src in ipaddress.ip_network(c, strict=False) for c in r["source"].split(",")):
                continue
            return r["action"] == "ACCEPT"
        return fw["options"].get("policy_in", "DROP") == "ACCEPT"

    # -- console ---------------------------------------------------------

    async def open_console(self, node, vmid):
        g = self._get(node, vmid)
        if g["status"] != "running":
            raise ProxmoxError(f"VM {vmid} is not running")
        console = MockConsole(g["name"])
        self.consoles.append(console)
        return console
