from __future__ import annotations

from conftest import KEY


def test_requires_login_and_csrf_header(portal):
    import httpx
    anon = httpx.AsyncClient(transport=httpx.ASGITransport(app=portal.app), base_url="http://test")
    assert portal.run(anon.get("/api/me")).status_code == 401
    alice = portal.client("alice")
    r = portal.run(alice.post("/api/vms", json={}, headers={"X-MACS": ""}))
    assert r.status_code == 403


def test_cluster_visibility_follows_groups(portal):
    ids = lambda u: [c["id"] for c in portal.call(u, "GET", "/api/clusters", 200).json()]
    assert ids("alice") == ["research", "homelab"]
    assert ids("sam") == ["homelab"]
    assert ids("admin") == ["research", "homelab"]
    r = portal.call("sam", "POST", "/api/vms", json={
        "cluster_id": "research", "name": "x", "template_id": "jam", "cores": 1, "memory_mb": 1024,
        "disk_gb": 10, "ssh_public_key": KEY, "justification": "x"})
    assert r.status_code == 404


def test_homelab_is_self_service_with_quota(portal):
    vm = portal.make_vm("sam", "homelab", "lab1", gpu=False)
    assert vm["status"] == "active" and vm["power"] == "running" and vm["vmid"] == 1000
    assert vm["ips"] and vm["gpu_access"] == "none"
    guest = portal.mocks["homelab"].guests[1000]
    assert guest["config"]["cores"] == 2 and "size=30G" in guest["config"]["scsi0"]
    assert guest["config"]["tags"] == "macs;owner-sam" and guest["config"]["sshkeys"].startswith("ssh-ed25519%20")

    portal.make_vm("sam", "homelab", "lab2", gpu=False)
    r = portal.call("sam", "POST", "/api/vms", json={
        "cluster_id": "homelab", "name": "lab3", "template_id": "ubuntu", "cores": 1, "memory_mb": 1024,
        "disk_gb": 10, "ssh_public_key": KEY})
    assert r.status_code == 422 and "quota" in r.json()["detail"]


def test_validation(portal):
    base = {"cluster_id": "homelab", "name": "ok", "template_id": "ubuntu", "cores": 1, "memory_mb": 1024,
            "disk_gb": 10, "ssh_public_key": KEY}
    assert portal.call("sam", "POST", "/api/vms", json={**base, "name": "Bad_Name!"}).status_code == 422
    assert portal.call("sam", "POST", "/api/vms", json={**base, "cores": 64}).status_code == 422
    assert portal.call("sam", "POST", "/api/vms", json={**base, "ssh_public_key": "nope"}).status_code == 422
    portal.call("sam", "POST", "/api/vms", 201, json=base)
    assert portal.call("sam", "POST", "/api/vms", json=base).status_code == 409  # duplicate name


def test_research_needs_approval(portal):
    body = {"cluster_id": "research", "name": "sim", "template_id": "jam", "cores": 2, "memory_mb": 2048,
            "disk_gb": 30, "ssh_public_key": KEY, "wants_gpu": True, "justification": "training"}
    vm = portal.call("alice", "POST", "/api/vms", 201, json=body).json()
    assert vm["status"] == "pending" and vm["gpu_access"] == "requested" and vm["vmid"] is None
    assert not portal.mocks["research"].guests.get(1000)

    assert portal.call("alice", "POST", f"/api/admin/vms/{vm['id']}/review", json={"approve": True}).status_code == 403
    assert [v["id"] for v in portal.call("admin", "GET", "/api/admin/approvals", 200).json()] == [vm["id"]]

    # Approve the VM but not the GPU.
    portal.call("admin", "POST", f"/api/admin/vms/{vm['id']}/review", 200, json={"approve": True, "grant_gpu": False})
    vm = portal.call("alice", "GET", f"/api/vms/{vm['id']}", 200).json()
    assert vm["status"] == "active" and vm["gpu_access"] == "none" and vm["power"] == "running"
    assert portal.book("alice", vm["id"], 1, 2, expect=422).json()["detail"].endswith("not approved for GPU use")

    # Ask for GPU access later.
    portal.call("alice", "POST", f"/api/vms/{vm['id']}/gpu-access", 200, json={"justification": "now I need it"})
    portal.call("admin", "POST", f"/api/admin/vms/{vm['id']}/review", 200, json={"approve": True})
    portal.book("alice", vm["id"], 1, 2)

    other = portal.call("bob", "POST", "/api/vms", 201, json={**body, "name": "nope"}).json()
    portal.call("admin", "POST", f"/api/admin/vms/{other['id']}/review", 200, json={"approve": False, "note": "no"})
    assert portal.call("bob", "GET", f"/api/vms/{other['id']}", 200).json()["status"] == "rejected"


def test_users_cannot_touch_each_others_vms(portal):
    vm = portal.make_vm("alice")
    assert portal.call("bob", "GET", f"/api/vms/{vm['id']}").status_code == 404
    assert portal.call("bob", "POST", f"/api/vms/{vm['id']}/power", json={"action": "stop"}).status_code == 404
    assert portal.call("bob", "DELETE", f"/api/vms/{vm['id']}").status_code == 404
    assert portal.book("bob", vm["id"], 1, 2, expect=404)
    assert portal.call("bob", "GET", "/api/vms?scope=all").status_code == 403
    assert portal.call("alice", "POST", "/api/admin/gpus/assign", json={"vm_id": vm["id"]}).status_code == 403


def test_power_and_delete(portal):
    vm = portal.make_vm("sam", "homelab", "lab", gpu=False)
    portal.call("sam", "POST", f"/api/vms/{vm['id']}/power", 200, json={"action": "shutdown"})
    assert portal.call("sam", "GET", f"/api/vms/{vm['id']}", 200).json()["power"] == "stopped"
    portal.call("sam", "POST", f"/api/vms/{vm['id']}/power", 200, json={"action": "start"})
    portal.call("sam", "DELETE", f"/api/vms/{vm['id']}", 200)
    assert 1000 not in portal.mocks["homelab"].guests
    assert portal.call("sam", "GET", "/api/vms", 200).json() == []


def test_booking_attaches_migrates_and_releases(portal):
    vm = portal.make_vm("alice")
    mock = portal.mocks["research"]
    # Park the VM on a node with no GPU so the booking has to migrate it.
    portal.call("alice", "POST", f"/api/vms/{vm['id']}/power", 200, json={"action": "stop"})
    mock.guests[vm["vmid"]]["node"] = "pve2"
    mock.node_names.append("pve9")
    portal.run(mock.migrate("pve2", vm["vmid"], "pve9"))
    portal.core.invalidate("research")

    res = portal.book("alice", vm["id"], 1, 3).json()
    portal.tick()
    assert portal.gpus() == {"gpu-1": None, "gpu-2": None}  # not time yet

    portal.shift(res["id"], 1.5)
    portal.tick()
    holders = portal.gpus()
    held = [g for g, h in holders.items() if h]
    assert len(held) == 1 and holders[held[0]]["vm_id"] == vm["id"] and holders[held[0]]["booked_until"]
    guest = mock.guests[vm["vmid"]]
    assert guest["status"] == "running" and guest["node"] in ("pve1", "pve2")
    assert guest["config"]["hostpci0"] == "mapping=rtx4090,pcie=1"
    detail = portal.call("alice", "GET", f"/api/vms/{vm['id']}", 200).json()
    assert detail["gpu"] == held[0] and detail["reservations"][0]["status"] == "active"

    portal.shift(res["id"], 2)
    portal.tick()
    assert portal.gpus() == {"gpu-1": None, "gpu-2": None}
    assert "hostpci0" not in guest["config"] and guest["status"] == "running"  # rebooted without the GPU
    detail = portal.call("alice", "GET", f"/api/vms/{vm['id']}", 200).json()
    assert detail["reservations"][0]["status"] == "completed"


def test_booking_capacity_and_overlap_rules(portal):
    a, b, c = (portal.make_vm(u, name=n) for u, n in (("alice", "a"), ("bob", "b"), ("alice", "c")))
    portal.book("alice", a["id"], 1, 5)
    portal.book("bob", b["id"], 2, 6)
    assert "GPUs are booked" in portal.book("alice", c["id"], 4, 8, expect=422).json()["detail"]
    portal.book("alice", c["id"], 5, 8)  # first slot frees up at +5h
    assert "overlapping" in portal.book("alice", a["id"], 4, 7, expect=422).json()["detail"]
    assert "limited to" in portal.book("alice", a["id"], 10, 200, expect=422).json()["detail"]
    assert "days ahead" in portal.book("alice", a["id"], 24 * 40, 24 * 40 + 1, expect=422).json()["detail"]
    assert portal.book("alice", a["id"], -3, -1, expect=422)


def test_cancel_active_booking_releases_gpu(portal):
    vm = portal.make_vm("alice")
    res = portal.book("alice", vm["id"], 0, 2).json()
    portal.tick()
    assert any(portal.gpus().values())
    portal.call("alice", "DELETE", f"/api/reservations/{res['id']}", 200)
    portal.tick()
    assert not any(portal.gpus().values())


def test_back_to_back_bookings_keep_the_gpu(portal):
    vm = portal.make_vm("alice")
    first = portal.book("alice", vm["id"], 0, 1).json()
    second = portal.book("alice", vm["id"], 1, 2).json()
    portal.tick()
    jobs_before = len(portal.call("admin", "GET", "/api/jobs?scope=all", 200).json())
    portal.shift(first["id"], 1.01)
    portal.shift(second["id"], 1.01)
    portal.tick()
    statuses = {r["id"]: r["status"] for r in portal.call("alice", "GET", f"/api/vms/{vm['id']}", 200).json()["reservations"]}
    assert statuses == {first["id"]: "completed", second["id"]: "active"}
    assert any(portal.gpus().values())
    assert len(portal.call("admin", "GET", "/api/jobs?scope=all", 200).json()) == jobs_before  # no reboot


def test_scheduler_preempts_unbooked_holder_but_not_external_vm(portal):
    a, b, c = (portal.make_vm(u, name=n) for u, n in (("alice", "a"), ("bob", "b"), ("bob", "c")))
    mock = portal.mocks["research"]
    # An unmanaged VM holds gpu-2; an admin hands gpu-1 to alice's VM without a booking.
    mock.seed_vm(500, "legacy", "pve2", running=True, hostpci0="mapping=rtx4090,pcie=1")
    portal.call("admin", "POST", "/api/admin/gpus/assign", 200, json={"vm_id": a["id"], "gpu_id": "gpu-1"})
    holders = portal.gpus()
    assert holders["gpu-1"]["vm_id"] == a["id"] and holders["gpu-2"]["vm_id"] is None
    assert holders["gpu-2"]["name"] == "legacy"

    portal.book("bob", b["id"], 0, 2)
    portal.tick()
    holders = portal.gpus()
    assert holders["gpu-1"]["vm_id"] == b["id"] and holders["gpu-2"]["name"] == "legacy"
    assert mock.guests[a["vmid"]]["status"] == "running" and "hostpci0" not in mock.guests[a["vmid"]]["config"]

    # Both GPUs are now untouchable, so the next booking fails cleanly.
    res = portal.book("bob", c["id"], 0, 1).json()
    portal.tick()
    got = portal.call("bob", "GET", f"/api/vms/{c['id']}", 200).json()["reservations"][0]
    assert got["id"] == res["id"] and got["status"] == "failed" and "no GPU is free" in got["error"]


def test_admin_swap_and_release(portal):
    a, b = portal.make_vm("alice", name="a"), portal.make_vm("bob", name="b")
    mock = portal.mocks["research"]
    portal.call("admin", "POST", "/api/admin/gpus/assign", 200, json={"vm_id": a["id"], "gpu_id": "gpu-2"})
    assert portal.gpus()["gpu-2"]["vm_id"] == a["id"] and mock.guests[a["vmid"]]["node"] == "pve2"
    portal.call("admin", "POST", "/api/admin/gpus/assign", 200, json={"vm_id": b["id"], "gpu_id": "gpu-2"})
    assert portal.gpus()["gpu-2"]["vm_id"] == b["id"]
    assert mock.guests[a["vmid"]]["status"] == "running"  # evicted VM comes back up
    portal.call("admin", "POST", "/api/admin/gpus/release", 200,
                json={"cluster_id": "research", "vmid": b["vmid"], "restart": False})
    assert portal.gpus() == {"gpu-1": None, "gpu-2": None}
    assert mock.guests[b["vmid"]]["status"] == "stopped"


def test_backup_archive_restore(portal):
    vm = portal.make_vm("alice")
    vid, vmid = vm["id"], vm["vmid"]
    mock = portal.mocks["research"]
    portal.call("alice", "POST", f"/api/vms/{vid}/backups", 200, json={"notes": "before upgrade"})
    backups = portal.call("alice", "GET", f"/api/vms/{vid}", 200).json()["backups"]
    assert len(backups) == 1 and backups[0]["notes"] == "before upgrade"

    # Roll back in place while holding a GPU: the passthrough must survive the restore.
    portal.call("admin", "POST", "/api/admin/gpus/assign", 200, json={"vm_id": vid})
    portal.call("alice", "POST", f"/api/vms/{vid}/restore", 200, json={"backup_id": backups[0]["id"]})
    assert "hostpci0" in mock.guests[vmid]["config"] and mock.guests[vmid]["status"] == "running"

    res = portal.book("alice", vid, 5, 6).json()
    portal.call("alice", "POST", f"/api/vms/{vid}/archive", 200)
    detail = portal.call("alice", "GET", f"/api/vms/{vid}", 200).json()
    assert detail["status"] == "archived" and vmid not in mock.guests and len(detail["backups"]) == 2
    assert not any(portal.gpus().values())
    assert all(r["status"] == "cancelled" for r in detail["reservations"] if r["id"] == res["id"])

    # The archived VM keeps its VMID reserved, so a new VM cannot inherit its backups.
    other = portal.make_vm("bob", name="other")
    assert other["vmid"] != vmid and other["backups"] == []
    assert portal.call("bob", "POST", f"/api/vms/{other['id']}/restore",
                       json={"backup_id": detail["backups"][0]["id"]}).status_code == 404

    portal.call("alice", "POST", f"/api/vms/{vid}/restore", 200, json={"backup_id": detail["backups"][0]["id"]})
    detail = portal.call("alice", "GET", f"/api/vms/{vid}", 200).json()
    assert detail["status"] == "active" and detail["power"] == "running"
    assert "hostpci0" not in mock.guests[vmid]["config"]


def test_adopt_existing_vm(portal):
    portal.client("alice")  # alice must exist
    portal.mocks["research"].seed_vm(500, "legacy", "pve1", running=True, hostpci0="mapping=rtx4090,pcie=1")
    assert [v["vmid"] for v in portal.call("admin", "GET", "/api/admin/unmanaged?cluster_id=research", 200).json()] == [500]
    portal.call("admin", "POST", "/api/admin/vms/adopt", 201,
                json={"cluster_id": "research", "vmid": 500, "owner": "alice", "gpu_access": True})
    vms = portal.call("alice", "GET", "/api/vms", 200).json()
    assert vms[0]["name"] == "legacy" and vms[0]["gpu"] == "gpu-1" and vms[0]["disk_gb"] == 40
    assert portal.call("admin", "GET", "/api/admin/unmanaged?cluster_id=research", 200).json() == []


def test_failed_provision_is_reported(portal):
    del portal.mocks["homelab"].guests[9000]  # template went missing
    vm = portal.call("sam", "POST", "/api/vms", 201, json={
        "cluster_id": "homelab", "name": "lab", "template_id": "ubuntu", "cores": 1, "memory_mb": 1024,
        "disk_gb": 10, "ssh_public_key": KEY}).json()
    detail = portal.call("sam", "GET", f"/api/vms/{vm['id']}", 200).json()
    assert detail["status"] == "error" and "template VM 9000 not found" in detail["error"]
    assert detail["jobs"][0]["status"] == "failed"
    portal.call("sam", "DELETE", f"/api/vms/{vm['id']}", 200)
