"""Console websocket, driven through Starlette's TestClient (httpx's ASGI transport has no websockets)."""
from __future__ import annotations

import struct
import time

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import KEY, Portal

H = {"X-MACS": "1"}


def login(portal: Portal, username: str) -> TestClient:
    c = TestClient(portal.app)
    c.__enter__()
    assert c.get("/auth/dev-login", params={"username": username}, follow_redirects=False).status_code == 307
    return c


@pytest.fixture
def lab():
    portal = Portal()
    sam = login(portal, "sam")
    vm = sam.post("/api/vms", headers=H, json={
        "cluster_id": "homelab", "name": "lab", "template_id": "ubuntu", "cores": 1, "memory_mb": 1024,
        "disk_gb": 10, "ssh_public_key": KEY}).json()
    for _ in range(100):
        detail = sam.get(f"/api/vms/{vm['id']}").json()
        if detail["status"] == "active" and not detail["busy"]:
            break
        time.sleep(0.02)
    assert detail["power"] == "running"
    yield portal, sam, detail
    sam.__exit__(None, None, None)


def test_connection_details(lab):
    portal, sam, vm = lab
    assert vm["connections"] == [{"kind": "ssh", "label": "SSH", "host": vm["ips"][0], "port": 22, "user": "ubuntu",
                                  "command": f"ssh ubuntu@{vm['ips'][0]}", "hosts": vm["ips"]}]
    portal.cfg.clusters[1].connect_domain = "netbird.selfhosted"
    portal.cfg.clusters[1].templates[0].connect = ["ssh", "rdp", "sunshine"]
    conns = sam.get(f"/api/vms/{vm['id']}").json()["connections"]
    assert [c["kind"] for c in conns] == ["ssh", "rdp", "sunshine"]
    assert conns[0]["command"] == "ssh ubuntu@lab.netbird.selfhosted"
    assert conns[0]["hosts"] == ["lab.netbird.selfhosted", *vm["ips"]]
    assert conns[2]["url"] == "https://lab.netbird.selfhosted:47990"


def test_console_streams_rfb_both_ways(lab):
    portal, sam, vm = lab
    grant = sam.post(f"/api/vms/{vm['id']}/console", headers=H).json()
    assert grant["password"] == "mock"
    with sam.websocket_connect(f"/api/console/{grant['token']}", subprotocols=["binary"],
                               headers={"Origin": "http://testserver"}) as ws:
        assert ws.accepted_subprotocol == "binary"
        assert ws.receive_bytes() == b"RFB 003.008\n"
        ws.send_bytes(b"RFB 003.008\n")
        assert ws.receive_bytes() == bytes([1, 1])
        ws.send_bytes(bytes([1]))
        assert ws.receive_bytes() == struct.pack(">I", 0)
        ws.send_bytes(bytes([1]))
        init = ws.receive_bytes()
        assert struct.unpack(">HH", init[:4]) == (800, 450) and init.endswith(b"lab (mock console)")
        ws.send_bytes(struct.pack(">BBHHHH", 3, 0, 0, 0, 800, 450))     # full framebuffer request
        frame = ws.receive_bytes()
        assert frame[:4] == struct.pack(">BxH", 0, 4) and len(frame) > 800 * 450 * 4
        ws.send_bytes(struct.pack(">BBxxI", 4, 1, 0x61))               # key down 'a'
        ws.send_bytes(struct.pack(">BBHHHH", 3, 1, 0, 0, 800, 450))     # incremental request
        update = ws.receive_bytes()
        assert update[:4] == struct.pack(">BxH", 0, 1) and len(update) == 4 + 12 + 9 * 14 * 4
    console = portal.mocks["homelab"].consoles[0]
    assert console.keys == 1
    for _ in range(50):
        if console._task.done():
            break
        time.sleep(0.02)
    assert console._task.done()  # upstream closed when the browser left

    # The token is single use.
    with pytest.raises(WebSocketDisconnect):
        with sam.websocket_connect(f"/api/console/{grant['token']}", headers={"Origin": "http://testserver"}):
            pass


def test_console_is_locked_to_the_owner_and_origin(lab):
    portal, sam, vm = lab
    alice = login(portal, "alice")
    try:
        assert alice.post(f"/api/vms/{vm['id']}/console", headers=H).status_code == 404
        assert sam.post(f"/api/vms/{vm['id']}/console").status_code == 403  # no CSRF header
        token = sam.post(f"/api/vms/{vm['id']}/console", headers=H).json()["token"]
        with pytest.raises(WebSocketDisconnect):     # someone else's session
            with alice.websocket_connect(f"/api/console/{token}", headers={"Origin": "http://testserver"}):
                pass
        with pytest.raises(WebSocketDisconnect):     # right session, hostile page
            with sam.websocket_connect(f"/api/console/{token}", headers={"Origin": "https://evil.example"}):
                pass
        with sam.websocket_connect(f"/api/console/{token}", headers={"Origin": "http://testserver"}) as ws:
            assert ws.receive_bytes().startswith(b"RFB")
    finally:
        alice.__exit__(None, None, None)


def test_console_needs_a_running_vm(lab):
    portal, sam, vm = lab
    sam.post(f"/api/vms/{vm['id']}/power", headers=H, json={"action": "stop"})
    for _ in range(100):
        if sam.get(f"/api/vms/{vm['id']}").json()["power"] == "stopped":
            break
        time.sleep(0.02)
    r = sam.post(f"/api/vms/{vm['id']}/console", headers=H)
    assert r.status_code == 409 and "start the VM" in r.json()["detail"]
    assert sam.get(f"/api/vms/{vm['id']}").json()["connections"] == []
