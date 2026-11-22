from __future__ import annotations

import asyncio
from datetime import timedelta

import httpx
import pytest

from app.config import Config
from app.core import Core
from app.db import Reservation, make_session_factory, utcnow
from app.main import create_app
from app.proxmox.mock import MockProxmox
from app.services import schedule

KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtestkeytestkeytestkeytestkeytestkeytestkey0 test@macs"

CONFIG = {
    "app": {"secret_key": "test-secret", "database_url": "sqlite:///:memory:"},
    "auth": {"mode": "dev", "admin_groups": ["admins"], "dev_users": [
        {"username": "admin", "groups": ["admins"]},
        {"username": "alice", "groups": ["members"]},
        {"username": "bob", "groups": ["members"]},
        {"username": "sam", "groups": ["students"]},
    ]},
    "clusters": [
        {"id": "research", "name": "Research", "kind": "research", "driver": "mock",
         "allowed_groups": ["members"], "approval": "required", "storage": "ceph", "shared_storage": True,
         "backup_storage": "pbs", "vmid_range": [1000, 1099],
         "templates": [{"id": "jam", "name": "Golden Jam", "vmid": 9000, "default_user": "baker", "gpu_ready": True}],
         "gpu": {"mapping": "rtx4090", "devices": [
             {"id": "gpu-1", "node": "pve1", "model": "RTX 4090"},
             {"id": "gpu-2", "node": "pve2", "model": "RTX 4090"}]}},
        {"id": "homelab", "name": "Homelab", "kind": "homelab", "driver": "mock", "approval": "none",
         "quota": {"max_vms": 2, "max_cores": 4}, "iso_storage": "isos",
         "network": {"isolate": True, "services": True, "access_sources": ["100.64.0.0/10"],
                     "public_sources": ["100.64.0.0/10"]},
         "limits": {"max_cores": 4, "max_memory_mb": 8192, "max_disk_gb": 50},
         "templates": [{"id": "ubuntu", "name": "Ubuntu", "vmid": 9000}]},
    ],
}


class Portal:
    """Drives the app in-process on one event loop so jobs and ticks can be awaited."""

    def __init__(self):
        self.cfg = Config.model_validate(CONFIG)
        self.loop = asyncio.new_event_loop()
        self.mocks = {c.id: MockProxmox(c) for c in self.cfg.clusters}
        self.core = Core(self.cfg, make_session_factory(self.cfg.app.database_url), dict(self.mocks))
        self.app = create_app(self.cfg, self.core, run_scheduler=False)
        self.app.state.core = self.core
        self.clients: dict[str, httpx.AsyncClient] = {}

    def run(self, coro):
        return self.loop.run_until_complete(coro)

    def client(self, username: str) -> httpx.AsyncClient:
        if username not in self.clients:
            c = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test",
                                  headers={"X-MACS": "1"})
            assert self.run(c.get("/auth/dev-login", params={"username": username})).status_code == 307
            self.clients[username] = c
        return self.clients[username]

    def call(self, username: str, method: str, path: str, expect: int | None = None, **kw):
        r = self.run(self.client(username).request(method, path, **kw))
        self.run(self.core.wait_jobs())
        if expect is not None:
            assert r.status_code == expect, f"{method} {path} -> {r.status_code} {r.text}"
        return r

    def tick(self):
        self.run(schedule.tick(self.core))

    def make_vm(self, username: str, cluster: str = "research", name: str = "box", gpu: bool = True, **kw) -> dict:
        """Request a VM and, on approval clusters, approve it. Returns the VM detail."""
        body = {"cluster_id": cluster, "name": name, "template_id": "jam" if cluster == "research" else "ubuntu",
                "cores": 2, "memory_mb": 2048, "disk_gb": 30, "ssh_public_key": KEY,
                "wants_gpu": gpu, "justification": "thesis", **kw}
        vm = self.call(username, "POST", "/api/vms", 201, json=body).json()
        if vm["status"] == "pending":
            self.call("admin", "POST", f"/api/admin/vms/{vm['id']}/review", 200,
                      json={"approve": True, "grant_gpu": gpu})
        return self.call(username, "GET", f"/api/vms/{vm['id']}", 200).json()

    def book(self, username: str, vm_id: int, start_h: float, end_h: float, expect: int = 201):
        now = utcnow()
        return self.call(username, "POST", "/api/reservations", expect, json={
            "vm_id": vm_id, "start_at": (now + timedelta(hours=start_h)).isoformat() + "Z",
            "end_at": (now + timedelta(hours=end_h)).isoformat() + "Z"})

    def shift(self, res_id: int, hours: float):
        """Move a booking earlier in time to simulate the clock advancing."""
        with self.core.Session.begin() as db:
            r = db.get(Reservation, res_id)
            r.start_at -= timedelta(hours=hours)
            r.end_at -= timedelta(hours=hours)

    def gpus(self) -> dict[str, dict | None]:
        data = self.call("admin", "GET", "/api/gpus", 200).json()
        return {d["id"]: d["holder"] for d in data[0]["devices"]}


@pytest.fixture
def portal():
    p = Portal()
    yield p
    for c in p.clients.values():
        p.run(c.aclose())
    p.loop.close()
