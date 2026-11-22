"""The real Proxmox client against a scripted HTTP transport."""
from __future__ import annotations

import asyncio
from urllib.parse import parse_qs

import httpx
import pytest

from app.config import ClusterConfig
from app.proxmox.base import ProxmoxError
from app.proxmox.client import ProxmoxClient

UPID = "UPID:pve1:0001:0002:0003:qmclone:9000:macs@pve!portal:"


def make(handler, **cfg):
    cluster = ClusterConfig(id="c", name="C", endpoint="https://pve:8006", **cfg)
    client = ProxmoxClient(cluster)
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://pve:8006/api2/json")
    return client


def test_token_auth_and_task_wait(monkeypatch):
    real_sleep = asyncio.sleep
    monkeypatch.setattr(asyncio, "sleep", lambda _s: real_sleep(0))  # don't wait between task polls
    seen, polls = [], iter(["running", "stopped"])

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path, req.headers.get("authorization"), req.content.decode()))
        if req.url.path.endswith("/clone"):
            return httpx.Response(200, json={"data": UPID})
        return httpx.Response(200, json={"data": {"status": next(polls), "exitstatus": "OK"}})

    c = make(handler, token_id="macs@pve!portal", token_secret="s3cret")
    asyncio.run(c.clone("pve1", 9000, 1000, "box", "ceph", target="pve2"))
    assert seen[0][:3] == ("POST", "/api2/json/nodes/pve1/qemu/9000/clone", "PVEAPIToken=macs@pve!portal=s3cret")
    assert parse_qs(seen[0][3]) == {"newid": ["1000"], "name": ["box"], "full": ["1"], "storage": ["ceph"], "target": ["pve2"]}
    assert len(seen) == 3 and all("/nodes/pve1/tasks/UPID" in s[1] for s in seen[1:])


def test_failed_task_raises(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "POST":
            return httpx.Response(200, json={"data": UPID})
        return httpx.Response(200, json={"data": {"status": "stopped", "exitstatus": "can't lock file"}})

    c = make(handler, token_id="t", token_secret="s")
    with pytest.raises(ProxmoxError, match="can't lock file"):
        asyncio.run(c.start("pve1", 100))


def test_http_error_carries_proxmox_message():
    c = make(lambda req: httpx.Response(403, json={"data": None, "message": "Permission check failed"}),
             token_id="t", token_secret="s")
    with pytest.raises(ProxmoxError, match="403.*Permission check failed"):
        asyncio.run(c.vm_config("pve1", 100))


def test_ticket_auth_and_config_delete():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.path.endswith("/access/ticket"):
            return httpx.Response(200, json={"data": {"ticket": "TICKET", "CSRFPreventionToken": "CSRF"}})
        return httpx.Response(200, json={"data": None})

    c = make(handler, username="root@pam", password="pw")

    async def go():
        await c.set_config("pve1", 100, delete="hostpci0")
        await c.set_config("pve1", 100, hostpci0="0000:01:00,pcie=1")

    asyncio.run(go())
    assert [r.url.path.rsplit("/", 1)[-1] for r in seen] == ["ticket", "config", "config"]  # one login, reused
    assert seen[1].method == "PUT" and seen[1].headers["CSRFPreventionToken"] == "CSRF"
    assert "PVEAuthCookie=TICKET" in seen[1].headers["cookie"]
    assert parse_qs(seen[2].content.decode()) == {"hostpci0": ["0000:01:00,pcie=1"]}


def test_inventory_filters_containers_and_ips_tolerate_no_agent():
    def handler(req: httpx.Request) -> httpx.Response:
        if "agent" in req.url.path:
            return httpx.Response(500, json={"data": None, "message": "QEMU guest agent is not running"})
        return httpx.Response(200, json={"data": [
            {"type": "qemu", "vmid": 100, "name": "a", "node": "pve1", "status": "running", "template": 0},
            {"type": "lxc", "vmid": 200, "name": "ct", "node": "pve1", "status": "running"},
            {"type": "qemu", "vmid": 9000, "name": "tpl", "node": "pve1", "status": "stopped", "template": 1}]})

    c = make(handler, token_id="t", token_secret="s")
    vms = asyncio.run(c.vms())
    assert [(v["vmid"], v["template"]) for v in vms] == [(100, False), (9000, True)]
    assert asyncio.run(c.vm_ips("pve1", 100)) == []
