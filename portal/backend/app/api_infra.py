"""API for the image library, published services and the infrastructure workspace."""
from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .api import get_vm, iso, service_out, user_out
from .auth import can_use, current_user, get_core, is_admin, require_admin
from .core import Core
from .db import VM, VM_LIVE, Image, Reservation, Service, User, utcnow
from .proxmox.base import ProxmoxError
from .services import gpus as gpu_svc
from .services import images as image_svc
from .services import network as net_svc

router = APIRouter(prefix="/api")
SLUG = re.compile(r"[^a-z0-9]+")


# -- published services --------------------------------------------------


class ServiceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field("", max_length=500)
    port: int = Field(ge=1, le=65535)
    protocol: Literal["tcp", "udp"] = "tcp"
    scheme: Literal["", "http", "https"] = ""


async def _sync_firewall(core: Core, vm_id: int) -> None:
    try:
        await net_svc.apply(core, vm_id)
    except ProxmoxError as e:
        raise HTTPException(502, f"could not update the VM's firewall: {e}") from e


@router.get("/services")
def service_directory(user: User = Depends(current_user), core: Core = Depends(get_core)):
    """Everything published on the clusters this user can use."""
    allowed = [c.id for c in core.cfg.clusters if c.network.services and can_use(core.cfg, user, c)]
    with core.Session() as db:
        rows = db.scalars(select(Service).join(VM).where(
            Service.status == "published", VM.status == "active", VM.cluster_id.in_(allowed)).order_by(Service.name))
        return [service_out(core, s) for s in rows]


@router.post("/vms/{vm_id}/services", status_code=201)
async def publish_service(vm_id: int, body: ServiceCreate, user: User = Depends(current_user),
                          core: Core = Depends(get_core)):
    with core.Session() as db:
        vm = get_vm(db, core, user, vm_id)
        cluster = core.cfg.cluster(vm.cluster_id)
        if not cluster or not cluster.network.services:
            raise HTTPException(409, "this cluster does not offer published services")
        if vm.status != "active":
            raise HTTPException(409, "the VM is not active")
        net = cluster.network
        if body.scheme and body.protocol != "tcp":
            raise HTTPException(422, "web services use TCP")
        if body.protocol == "tcp" and body.port in net.access_ports:
            raise HTTPException(422, f"port {body.port} is your own access port and cannot be published")
        existing = list(db.scalars(select(Service).where(Service.vm_id == vm.id, Service.status != "rejected")))
        if any(s.port == body.port and s.protocol == body.protocol for s in existing):
            raise HTTPException(409, f"{body.protocol}/{body.port} is already published on this VM")
        if len(existing) >= net.max_services_per_vm:
            raise HTTPException(422, f"a VM can publish at most {net.max_services_per_vm} services")
        svc = Service(vm_id=vm.id, name=body.name.strip(), description=body.description.strip(), port=body.port,
                      protocol=body.protocol, scheme=body.scheme,
                      status="published" if net.service_approval == "none" or is_admin(core.cfg, user) else "pending")
        db.add(svc)
        core.audit(db, user, "publish-service" if svc.status == "published" else "request-service",
                   f"{vm.cluster_id}/{vm.name}", f"{body.name} {body.protocol}/{body.port}")
        db.flush()
        if svc.status == "published":
            # Commit only once the port is really open (the firewall reads committed rows).
            db.commit()
            try:
                await _sync_firewall(core, vm.id)
            except HTTPException:
                db.delete(svc)
                db.commit()
                raise
        else:
            db.commit()
        return service_out(core, svc)


@router.delete("/services/{service_id}")
async def remove_service(service_id: int, user: User = Depends(current_user), core: Core = Depends(get_core)):
    with core.Session() as db:
        svc = db.get(Service, service_id)
        if not svc or (svc.vm.owner_id != user.id and not is_admin(core.cfg, user)):
            raise HTTPException(404, "service not found")
        vm_id, was_open, active = svc.vm_id, svc.status == "published", svc.vm.status == "active"
        core.audit(db, user, "unpublish-service", f"{svc.vm.cluster_id}/{svc.vm.name}", f"{svc.name} {svc.protocol}/{svc.port}")
        db.delete(svc)
        db.commit()
    if was_open and active:
        await _sync_firewall(core, vm_id)
    return {"ok": True}


class ServiceReview(BaseModel):
    approve: bool
    note: str = Field("", max_length=1000)


@router.post("/admin/services/{service_id}/review")
async def review_service(service_id: int, body: ServiceReview, admin: User = Depends(require_admin),
                         core: Core = Depends(get_core)):
    with core.Session() as db:
        svc = db.get(Service, service_id)
        if not svc or svc.status != "pending":
            raise HTTPException(404, "nothing to review")
        svc.status, svc.review_note = ("published" if body.approve else "rejected"), body.note.strip()
        vm_id = svc.vm_id
        core.audit(db, admin, "approve-service" if body.approve else "reject-service",
                   f"{svc.vm.cluster_id}/{svc.vm.name}", f"{svc.name} {svc.protocol}/{svc.port}")
        db.commit()
    if body.approve:
        try:
            await _sync_firewall(core, vm_id)
        except HTTPException:
            with core.Session.begin() as db:
                db.get(Service, service_id).status = "pending"
            raise
    return {"ok": True}


@router.get("/admin/services")
def all_services(admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    with core.Session() as db:
        return [service_out(core, s) for s in db.scalars(
            select(Service).join(VM).where(VM.status != "deleted").order_by(Service.id.desc()))]


@router.post("/admin/clusters/{cluster_id}/network/sync")
async def network_sync(cluster_id: str, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    """Re-apply the firewall policy to every portal VM, e.g. after changing allowed sources."""
    cluster = core.cfg.cluster(cluster_id)
    if not cluster or not cluster.network.isolate:
        raise HTTPException(409, "this cluster does not use network isolation")
    with core.Session() as db:
        ids = [(v.id, v.name) for v in db.scalars(select(VM).where(VM.cluster_id == cluster_id, VM.status == "active"))]
        job = core.create_job(db, "network-sync", None, admin)
        core.audit(db, admin, "network-sync", cluster_id, f"{len(ids)} VMs")
        db.commit()

    async def run(log):
        failed = 0
        for vm_id, name in ids:
            try:
                await net_svc.apply(core, vm_id)
                log(f"{name}: ok")
            except ProxmoxError as e:
                failed += 1
                log(f"{name}: FAILED {e}")
        if failed:
            raise ProxmoxError(f"{failed} of {len(ids)} VMs could not be updated")

    core.spawn_job(job.id, run)
    return {"job_id": job.id}


# -- image library -------------------------------------------------------


class ImageBody(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str = Field("", max_length=2000)
    os: Literal["linux", "windows", "other"] = "linux"
    default_user: str = Field("", max_length=64)
    cicustom: str = Field("", max_length=255)
    gpu_ready: bool = False
    tags: list[str] = []
    connect: list[Literal["ssh", "rdp", "sunshine"]] | None = None
    enabled: bool = True


class ImageCreate(ImageBody):
    cluster_id: str
    kind: Literal["template", "iso"]
    vmid: int | None = None
    volid: str = ""


async def _discover(core: Core, cluster) -> dict:
    """Templates and ISOs that exist on the cluster right now."""
    drv = core.driver(cluster.id)
    templates = [{"vmid": v["vmid"], "name": v["name"], "node": v["node"]}
                 for v in sorted((await core.live_vms(cluster.id)).values(), key=lambda v: v["vmid"]) if v["template"]]
    isos: dict[str, dict] = {}
    if cluster.iso_storage:
        for n in await drv.nodes():
            if n["status"] != "online":
                continue
            try:
                for v in await drv.storage_content(n["node"], cluster.iso_storage, "iso"):
                    isos.setdefault(v["volid"], v)
            except ProxmoxError:
                continue  # storage not present on this node
    return {"templates": templates, "isos": sorted(isos.values(), key=lambda v: v["volid"])}


@router.get("/admin/images")
async def admin_images(cluster_id: str, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    cluster = core.cfg.cluster(cluster_id)
    if not cluster:
        raise HTTPException(404, "cluster not found")
    try:
        found, error = await _discover(core, cluster), None
    except ProxmoxError as e:
        found, error = {"templates": [], "isos": []}, str(e)
    with core.Session() as db:
        rows = list(db.scalars(select(Image).where(Image.cluster_id == cluster_id).order_by(Image.name)))
        in_use = dict(db.execute(select(VM.template_id, func.count(VM.id)).where(
            VM.cluster_id == cluster_id, VM.status.in_(VM_LIVE)).group_by(VM.template_id)).all())
    listed_vmids = {i.vmid for i in rows if i.kind == "template"}
    listed_isos = {i.volid for i in rows if i.kind == "iso"}
    live_vmids = {t["vmid"] for t in found["templates"]}
    live_isos = {i["volid"] for i in found["isos"]}
    return {
        "images": [{**image_svc.out(i, admin=True), "vm_count": in_use.get(i.slug, 0),
                    # Flag entries whose backing template/ISO has vanished from the cluster.
                    "missing": not error and (i.vmid not in live_vmids if i.kind == "template"
                                              else bool(cluster.iso_storage) and i.volid not in live_isos)}
                   for i in rows],
        "unlisted": {"templates": [t for t in found["templates"] if t["vmid"] not in listed_vmids],
                     "isos": [i for i in found["isos"] if i["volid"] not in listed_isos]},
        "iso_storage": cluster.iso_storage, "error": error,
    }


def _clean(body: ImageBody) -> dict:
    data = body.model_dump(exclude={"cluster_id", "kind", "vmid", "volid"})
    data["tags"] = sorted({t.strip().lower() for t in body.tags if t.strip()})[:8]
    data["name"] = body.name.strip()
    return data


@router.post("/admin/images", status_code=201)
async def add_image(body: ImageCreate, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    cluster = core.cfg.cluster(body.cluster_id)
    if not cluster:
        raise HTTPException(404, "cluster not found")
    found = await _discover(core, cluster)
    if body.kind == "template" and body.vmid not in {t["vmid"] for t in found["templates"]}:
        raise HTTPException(422, f"VM {body.vmid} is not a template on {cluster.name}")
    if body.kind == "iso" and body.volid not in {i["volid"] for i in found["isos"]}:
        raise HTTPException(422, f"that ISO is not on {cluster.name}'s ISO storage")
    with core.Session() as db:
        base = SLUG.sub("-", body.name.lower()).strip("-")[:48] or "image"
        slug, n = base, 2
        while image_svc.get(db, cluster.id, slug):
            slug, n = f"{base}-{n}", n + 1
        image = Image(cluster_id=cluster.id, slug=slug, kind=body.kind,
                      vmid=body.vmid if body.kind == "template" else None,
                      volid=body.volid if body.kind == "iso" else "", **_clean(body))
        db.add(image)
        core.audit(db, admin, "add-image", f"{cluster.id}/{slug}", body.name)
        db.commit()
        return image_svc.out(image, admin=True)


@router.put("/admin/images/{image_id}")
def edit_image(image_id: int, body: ImageBody, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    with core.Session() as db:
        image = db.get(Image, image_id)
        if not image:
            raise HTTPException(404, "image not found")
        for k, v in _clean(body).items():
            setattr(image, k, v)
        core.audit(db, admin, "edit-image", f"{image.cluster_id}/{image.slug}")
        db.commit()
        return image_svc.out(image, admin=True)


@router.delete("/admin/images/{image_id}")
def delete_image(image_id: int, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    """Removes the library entry only; the template or ISO stays on the cluster."""
    with core.Session() as db:
        image = db.get(Image, image_id)
        if not image:
            raise HTTPException(404, "image not found")
        if db.scalar(select(VM.id).where(VM.cluster_id == image.cluster_id, VM.template_id == image.slug,
                                         VM.status.in_(("pending", "provisioning"))).limit(1)):
            raise HTTPException(409, "a VM request is waiting on this image; hide it instead")
        core.audit(db, admin, "remove-image", f"{image.cluster_id}/{image.slug}")
        db.delete(image)
        db.commit()
    return {"ok": True}


# -- overview ------------------------------------------------------------


@router.get("/admin/overview")
async def overview(admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    out = []
    now = utcnow()
    for c in core.cfg.clusters:
        drv = core.driver(c.id)
        error, nodes, live, gpus, firewall_ok = None, [], {}, [], None
        try:
            nodes = await core.cached((c.id, "nodes"), drv.nodes, max_age=15)
            live = await core.live_vms(c.id)
            gpus = await gpu_svc.gpu_state(core, c) if c.has_gpus else []
            if c.network.isolate:
                firewall_ok = await core.cached((c.id, "dcfw"), drv.cluster_firewall_enabled, max_age=60)
        except ProxmoxError as e:
            error = str(e)
        with core.Session() as db:
            managed = list(db.scalars(select(VM).where(VM.cluster_id == c.id, VM.status.in_(("active", "provisioning")))))
            pending_vms = db.scalar(select(func.count(VM.id)).where(VM.cluster_id == c.id, VM.status == "pending"))
            pending_gpu = db.scalar(select(func.count(VM.id)).where(
                VM.cluster_id == c.id, VM.status == "active", VM.gpu_access == "requested"))
            pending_svc = db.scalar(select(func.count(Service.id)).join(VM).where(
                VM.cluster_id == c.id, VM.status == "active", Service.status == "pending"))
            published = db.scalar(select(func.count(Service.id)).join(VM).where(
                VM.cluster_id == c.id, VM.status == "active", Service.status == "published"))
            booked = db.scalar(select(func.count(Reservation.id)).where(
                Reservation.cluster_id == c.id, Reservation.status == "active"))
            upcoming = db.scalar(select(func.count(Reservation.id)).where(
                Reservation.cluster_id == c.id, Reservation.status == "scheduled", Reservation.start_at > now))
            archived = db.scalar(select(func.count(VM.id)).where(VM.cluster_id == c.id, VM.status == "archived"))
            images = db.scalar(select(func.count(Image.id)).where(Image.cluster_id == c.id, Image.enabled))
            owners = len({v.owner_id for v in managed})
        known = {v.vmid for v in managed}
        guests = [v for v in live.values() if not v["template"]]
        out.append({
            "id": c.id, "name": c.name, "kind": c.kind, "error": error, "nodes": nodes,
            "vms": {"managed": len(managed), "owners": owners, "archived": archived,
                    "running": sum(1 for v in guests if v["vmid"] in known and v["status"] == "running"),
                    "unmanaged": sum(1 for v in guests if v["vmid"] not in known)},
            "allocated": {"cores": sum(v.cores for v in managed), "memory_mb": sum(v.memory_mb for v in managed),
                          "disk_gb": sum(v.disk_gb for v in managed)},
            "capacity": {"cores": sum(n["maxcpu"] for n in nodes),
                         "memory_mb": int(sum(n["maxmem"] for n in nodes) / 1024 / 1024)},
            "gpus": {"total": len(c.gpu.devices), "in_use": sum(1 for g in gpus if g["holder"]),
                     "booked": booked, "upcoming": upcoming} if c.has_gpus else None,
            "pending": {"vms": pending_vms, "gpu": pending_gpu, "services": pending_svc},
            "network": {"label": c.network.label, "isolated": c.network.isolate, "services": c.network.services,
                        "published": published, "firewall_ok": firewall_ok,
                        "access_ports": c.network.access_ports, "access_sources": c.network.access_sources,
                        "public_sources": c.network.public_sources, "service_approval": c.network.service_approval,
                        "bridge": c.bridge, "vlan": c.vlan},
            "images": images,
        })
    return out


@router.get("/admin/people")
def people(admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    with core.Session() as db:
        counts: dict[int, dict] = {}
        for owner_id, n, cores, mem in db.execute(
                select(VM.owner_id, func.count(VM.id), func.sum(VM.cores), func.sum(VM.memory_mb))
                .where(VM.status.in_(VM_LIVE)).group_by(VM.owner_id)):
            counts[owner_id] = {"vms": n, "cores": int(cores or 0), "memory_mb": int(mem or 0)}
        return [{**user_out(u), "email": u.email, "groups": u.groups, "last_login_at": iso(u.last_login_at),
                 "is_admin": is_admin(core.cfg, u), **counts.get(u.id, {"vms": 0, "cores": 0, "memory_mb": 0})}
                for u in db.scalars(select(User).order_by(User.username))]
