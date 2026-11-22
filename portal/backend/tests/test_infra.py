"""Network isolation, published services, the image library and the infra overview."""
from __future__ import annotations

from conftest import KEY

NETBIRD, NEIGHBOUR = "100.64.3.7", "10.20.0.50"


def test_homelab_vms_are_isolated_but_owner_can_get_in(portal):
    a = portal.make_vm("sam", "homelab", "a", gpu=False)
    mock = portal.mocks["homelab"]
    guest = mock.guests[a["vmid"]]
    assert "firewall=1" in guest["config"]["net0"]
    assert guest["firewall"]["options"] | {"enable": 1, "policy_in": "DROP"} == guest["firewall"]["options"]
    assert mock.reachable(a["vmid"], NETBIRD, 22)                  # owner over NetBird
    assert not mock.reachable(a["vmid"], NEIGHBOUR, 22)            # another homelab VM
    assert not mock.reachable(a["vmid"], NETBIRD, 8080)            # nothing published yet
    assert not mock.reachable(a["vmid"], NEIGHBOUR, 8080)


def test_research_vms_sit_on_the_lab_network_unfiltered(portal):
    vm = portal.make_vm("alice", gpu=False)
    mock = portal.mocks["research"]
    assert "firewall" not in mock.guests[vm["vmid"]]
    assert mock.reachable(vm["vmid"], NEIGHBOUR, 8080)
    r = portal.call("alice", "POST", f"/api/vms/{vm['id']}/services", json={"name": "x", "port": 80})
    assert r.status_code == 409


def test_publish_and_unpublish_a_service(portal):
    vm = portal.make_vm("sam", "homelab", "web", gpu=False)
    mock, vmid = portal.mocks["homelab"], vm["vmid"]
    portal.cfg.clusters[1].connect_domain = "netbird.selfhosted"
    svc = portal.call("sam", "POST", f"/api/vms/{vm['id']}/services", 201,
                      json={"name": "Blog", "port": 8080, "scheme": "http", "description": "my blog"}).json()
    assert svc["status"] == "published" and svc["url"] == "http://web.netbird.selfhosted:8080"
    assert mock.reachable(vmid, NETBIRD, 8080)
    assert not mock.reachable(vmid, NEIGHBOUR, 8080)   # still closed to neighbours
    assert not mock.reachable(vmid, NETBIRD, 8081)
    assert mock.reachable(vmid, NETBIRD, 22)

    # Visible in the directory to others on the cluster; only the owner can remove it.
    assert [s["name"] for s in portal.call("alice", "GET", "/api/services", 200).json()] == ["Blog"]
    assert portal.call("alice", "DELETE", f"/api/services/{svc['id']}").status_code == 404
    assert portal.call("sam", "GET", f"/api/vms/{vm['id']}", 200).json()["services"][0]["port"] == 8080

    # Guard rails.
    post = lambda **b: portal.call("sam", "POST", f"/api/vms/{vm['id']}/services", json={"name": "x", **b})
    assert post(port=8080).status_code == 409                       # duplicate
    assert post(port=22).status_code == 422                         # the access port
    assert post(port=53, protocol="udp", scheme="http").status_code == 422
    assert post(port=53, protocol="udp").status_code == 201
    assert mock.reachable(vmid, NETBIRD, 53, "udp") and not mock.reachable(vmid, NETBIRD, 53, "tcp")
    for p in (1, 2, 3):
        assert post(port=9000 + p).status_code == 201
    assert "at most 5" in post(port=9999).json()["detail"]

    # A rule added by hand in Proxmox survives the portal rewriting its own.
    portal.run(mock.firewall_add_rule("pve1", vmid, type="in", action="ACCEPT", proto="tcp", dport="5000", comment="by hand"))
    portal.call("sam", "DELETE", f"/api/services/{svc['id']}", 200)
    assert not mock.reachable(vmid, NETBIRD, 8080)
    assert mock.reachable(vmid, NETBIRD, 5000) and mock.reachable(vmid, NETBIRD, 22)
    comments = [r.get("comment", "") for r in mock.guests[vmid]["firewall"]["rules"]]
    assert comments.count("macs:access") == 1  # rewrites do not pile up duplicates
    assert sum(c.startswith("macs:service") for c in comments) == 4


def test_service_approval_when_required(portal):
    portal.cfg.clusters[1].network.service_approval = "required"
    vm = portal.make_vm("sam", "homelab", "web", gpu=False)
    mock, vmid = portal.mocks["homelab"], vm["vmid"]
    svc = portal.call("sam", "POST", f"/api/vms/{vm['id']}/services", 201, json={"name": "Blog", "port": 8080}).json()
    assert svc["status"] == "pending" and not mock.reachable(vmid, NETBIRD, 8080)
    assert portal.call("alice", "GET", "/api/services", 200).json() == []
    assert portal.call("sam", "POST", f"/api/admin/services/{svc['id']}/review", json={"approve": True}).status_code == 403
    assert [s["id"] for s in portal.call("admin", "GET", "/api/admin/approvals", 200).json()["services"]] == [svc["id"]]
    portal.call("admin", "POST", f"/api/admin/services/{svc['id']}/review", 200, json={"approve": True})
    assert mock.reachable(vmid, NETBIRD, 8080)
    assert portal.call("admin", "GET", "/api/admin/approvals", 200).json()["services"] == []

    other = portal.call("sam", "POST", f"/api/vms/{vm['id']}/services", 201, json={"name": "DB", "port": 5432}).json()
    portal.call("admin", "POST", f"/api/admin/services/{other['id']}/review", 200, json={"approve": False, "note": "no"})
    assert not mock.reachable(vmid, NETBIRD, 5432)
    statuses = {s["name"]: s["status"] for s in portal.call("sam", "GET", f"/api/vms/{vm['id']}", 200).json()["services"]}
    assert statuses == {"Blog": "published", "DB": "rejected"}


def test_firewall_follows_the_vm_through_restore_delete_and_resync(portal):
    portal.cfg.clusters[1].backup_storage = "pbs"
    vm = portal.make_vm("sam", "homelab", "web", gpu=False)
    mock, vmid, vid = portal.mocks["homelab"], vm["vmid"], vm["id"]
    portal.call("sam", "POST", f"/api/vms/{vid}/backups", 200, json={})
    backup = portal.call("sam", "GET", f"/api/vms/{vid}", 200).json()["backups"][0]
    # Backup has no services; publish one afterwards, then roll back: it must stay open.
    portal.call("sam", "POST", f"/api/vms/{vid}/services", 201, json={"name": "Blog", "port": 8080})
    portal.call("sam", "POST", f"/api/vms/{vid}/restore", 200, json={"backup_id": backup["id"]})
    assert mock.reachable(vmid, NETBIRD, 8080) and not mock.reachable(vmid, NEIGHBOUR, 8080)

    # Policy change + resync.
    portal.cfg.clusters[1].network.public_sources = ["10.99.0.1"]
    assert portal.call("sam", "POST", "/api/admin/clusters/homelab/network/sync").status_code == 403
    portal.call("admin", "POST", "/api/admin/clusters/homelab/network/sync", 200)
    assert mock.reachable(vmid, "10.99.0.1", 8080) and not mock.reachable(vmid, NETBIRD, 8080)
    assert portal.call("admin", "POST", "/api/admin/clusters/research/network/sync").status_code == 409

    portal.call("sam", "DELETE", f"/api/vms/{vid}", 200)
    assert portal.call("admin", "GET", "/api/admin/services", 200).json() == []


def test_adopted_vm_gets_isolated(portal):
    portal.client("sam")
    mock = portal.mocks["homelab"]
    mock.seed_vm(500, "old-box", "pve1", running=True, net0="virtio=AA:BB:CC:00:00:01,bridge=vmbr0")
    assert mock.reachable(500, NEIGHBOUR, 22)
    portal.call("admin", "POST", "/api/admin/vms/adopt", 201, json={"cluster_id": "homelab", "vmid": 500, "owner": "sam"})
    assert not mock.reachable(500, NEIGHBOUR, 22) and mock.reachable(500, NETBIRD, 22)


def test_image_library_curation(portal):
    lib = lambda u, c: [i["id"] for i in next(x for x in portal.call(u, "GET", "/api/clusters", 200).json() if x["id"] == c)["images"]]
    assert lib("alice", "research") == ["jam"] and lib("sam", "homelab") == ["ubuntu"]
    research = portal.call("alice", "GET", "/api/clusters", 200).json()[0]
    assert research["images"][0]["gpu_ready"] is True

    assert portal.call("sam", "GET", "/api/admin/images?cluster_id=homelab").status_code == 403
    admin = portal.call("admin", "GET", "/api/admin/images?cluster_id=homelab", 200).json()
    assert [i["id"] for i in admin["images"]] == ["ubuntu"] and not admin["images"][0]["missing"]
    assert admin["unlisted"]["templates"] == [] and len(admin["unlisted"]["isos"]) == 4

    # Add an ISO and a second template; bogus sources are refused.
    mock = portal.mocks["homelab"]
    mock.seed_vm(9010, "debian-12-cloud", "pve1")
    mock.guests[9010]["template"] = True
    portal.core.invalidate("homelab")
    add = lambda **b: portal.call("admin", "POST", "/api/admin/images", json={"cluster_id": "homelab", **b})
    assert add(kind="template", name="Nope", vmid=1234).status_code == 422
    assert add(kind="iso", name="Nope", volid="isos:iso/missing.iso").status_code == 422
    deb = add(kind="template", name="Debian 12", vmid=9010, default_user="debian", tags=["Minimal", "minimal "])
    assert deb.status_code == 201 and deb.json()["id"] == "debian-12" and deb.json()["tags"] == ["minimal"]
    iso = add(kind="iso", name="NixOS installer", volid="isos:iso/nixos-minimal-24.11-x86_64-linux.iso", os="other").json()
    assert lib("sam", "homelab") == ["debian-12", "ubuntu", "nixos-installer"]  # templates before ISOs

    # Hide one: gone for users, still listed for admins, and cannot be deployed.
    body = {k: deb.json()[k] for k in ("name", "description", "os", "default_user", "cicustom", "gpu_ready", "tags", "connect")}
    portal.call("admin", "PUT", f"/api/admin/images/{deb.json()['db_id']}", 200, json={**body, "enabled": False})
    assert "debian-12" not in lib("sam", "homelab")
    r = portal.call("sam", "POST", "/api/vms", json={"cluster_id": "homelab", "name": "x", "template_id": "debian-12",
                                                    "cores": 1, "memory_mb": 1024, "disk_gb": 10, "ssh_public_key": KEY})
    assert r.status_code == 422 and "library" in r.json()["detail"]

    # A template deleted from Proxmox is flagged for the admins.
    del mock.guests[9000]
    portal.core.invalidate("homelab")
    flagged = {i["id"]: i["missing"] for i in portal.call("admin", "GET", "/api/admin/images?cluster_id=homelab", 200).json()["images"]}
    assert flagged == {"debian-12": False, "ubuntu": True, "nixos-installer": False}

    portal.call("admin", "DELETE", f"/api/admin/images/{iso['db_id']}", 200)
    assert lib("sam", "homelab") == ["ubuntu"]


def test_deploy_from_iso(portal):
    iso = portal.call("admin", "POST", "/api/admin/images", 201, json={
        "cluster_id": "homelab", "kind": "iso", "name": "Debian installer", "os": "linux",
        "volid": "isos:iso/debian-12.8.0-amd64-netinst.iso"}).json()
    vm = portal.call("sam", "POST", "/api/vms", 201, json={
        "cluster_id": "homelab", "name": "from-iso", "template_id": iso["id"], "cores": 2, "memory_mb": 2048,
        "disk_gb": 20}).json()                                    # no SSH key needed
    detail = portal.call("sam", "GET", f"/api/vms/{vm['id']}", 200).json()
    assert detail["status"] == "active" and detail["power"] == "running" and detail["image"]["kind"] == "iso"
    assert "console" in detail["jobs"][0]["log"]
    mock = portal.mocks["homelab"]
    config = mock.guests[detail["vmid"]]["config"]
    assert config["ide2"] == "isos:iso/debian-12.8.0-amd64-netinst.iso,media=cdrom"
    assert config["machine"] == "q35" and config["bios"] == "ovmf" and "size=20G" in config["scsi0"]
    assert config["boot"] == "order=scsi0;ide2" and config["tags"] == "macs;owner-sam"
    assert "sshkeys" not in config and "firewall=1" in config["net0"]
    assert not mock.reachable(detail["vmid"], NEIGHBOUR, 22)      # isolated like any other homelab VM


def test_overview_and_people(portal):
    portal.make_vm("alice", name="a")
    lab = portal.make_vm("sam", "homelab", "lab", gpu=False)
    portal.call("sam", "POST", f"/api/vms/{lab['id']}/services", 201, json={"name": "Blog", "port": 8080})
    portal.mocks["research"].seed_vm(500, "legacy", "pve2", running=True, hostpci0="mapping=rtx4090,pcie=1")
    portal.core.invalidate("research")
    portal.call("bob", "POST", "/api/vms", 201, json={
        "cluster_id": "research", "name": "wait", "template_id": "jam", "cores": 2, "memory_mb": 2048,
        "disk_gb": 30, "ssh_public_key": KEY, "justification": "x"})
    assert portal.call("alice", "GET", "/api/admin/overview").status_code == 403
    research, homelab = portal.call("admin", "GET", "/api/admin/overview", 200).json()
    assert research["vms"] == {"managed": 1, "owners": 1, "archived": 0, "running": 1, "unmanaged": 1}
    assert research["gpus"] == {"total": 2, "in_use": 1, "booked": 0, "upcoming": 0}
    assert research["pending"] == {"vms": 1, "gpu": 0, "services": 0}
    assert research["allocated"]["cores"] == 2 and research["network"]["firewall_ok"] is None
    assert homelab["gpus"] is None and homelab["network"]["published"] == 1 and homelab["network"]["firewall_ok"] is True

    portal.mocks["homelab"].datacenter_firewall = False
    portal.core.invalidate("homelab")
    assert portal.call("admin", "GET", "/api/admin/overview", 200).json()[1]["network"]["firewall_ok"] is False

    people = {p["username"]: p for p in portal.call("admin", "GET", "/api/admin/people", 200).json()}
    assert people["alice"]["vms"] == 1 and people["bob"]["vms"] == 1 and people["admin"]["is_admin"]
