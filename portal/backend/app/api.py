"""JSON API consumed by the web UI."""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import can_use, current_user, get_core, is_admin, require_admin
from .core import Busy, Core
from .db import VM, VM_LIVE, Audit, Backup, Job, Reservation, User, utcnow
from .proxmox.base import ProxmoxError
from .services import backups as backup_svc
from .services import gpus as gpu_svc
from .services import schedule
from .services import vms as vm_svc

router = APIRouter(prefix="/api")

NAME = re.compile(r"^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$")
SSH_KEY = re.compile(r"^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-\S+) [A-Za-z0-9+/=]+( .*)?$")


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") + "Z" if dt else None


def to_utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def user_out(u: User | None) -> dict | None:
    return {"id": u.id, "username": u.username, "name": u.name or u.username} if u else None


async def live_view(core: Core, cluster_id: str) -> dict[str, Any]:
    """Live VM + GPU-holder maps for a cluster; degrades to empty with an error string."""
    try:
        vms = await core.live_vms(cluster_id)
        cluster = core.cluster(cluster_id)
        gpus = await gpu_svc.gpu_state(core, cluster) if cluster.has_gpus else []
        return {"vms": vms, "gpu_by_vmid": {g["holder"]["vmid"]: g["id"] for g in gpus if g["holder"]},
                "gpus": gpus, "error": None}
    except (ProxmoxError, KeyError) as e:
        return {"vms": {}, "gpu_by_vmid": {}, "gpus": [], "error": str(e)}


def vm_out(db: Session, core: Core, vm: VM, live: dict[str, Any]) -> dict:
    lv = live["vms"].get(vm.vmid) if vm.vmid is not None else None
    power = None
    if vm.status == "active":
        power = "unknown" if live["error"] else (lv["status"] if lv else "missing")
    return {
        "id": vm.id, "cluster_id": vm.cluster_id, "vmid": vm.vmid, "name": vm.name,
        "owner": user_out(vm.owner), "template_id": vm.template_id,
        "cores": vm.cores, "memory_mb": vm.memory_mb, "disk_gb": vm.disk_gb,
        "status": vm.status, "power": power, "node": lv["node"] if lv else None,
        "uptime": lv["uptime"] if lv else 0,
        "gpu_access": vm.gpu_access, "gpu": live["gpu_by_vmid"].get(vm.vmid) if vm.status == "active" else None,
        "justification": vm.justification, "review_note": vm.review_note,
        "reviewed_by": user_out(vm.reviewed_by), "error": vm.error,
        "busy": core.vm_busy(db, vm.id), "created_at": iso(vm.created_at),
    }


def res_out(r: Reservation) -> dict:
    return {"id": r.id, "cluster_id": r.cluster_id, "vm_id": r.vm_id, "vm_name": r.vm.name,
            "user": user_out(r.user), "start_at": iso(r.start_at), "end_at": iso(r.end_at),
            "status": r.status, "gpu_id": r.gpu_id or None, "note": r.note, "error": r.error}


def job_out(j: Job) -> dict:
    return {"id": j.id, "kind": j.kind, "status": j.status, "vm_id": j.vm_id,
            "vm_name": j.vm.name if j.vm else None, "user": user_out(j.user), "log": j.log,
            "error": j.error, "created_at": iso(j.created_at), "finished_at": iso(j.finished_at)}


def get_vm(db: Session, core: Core, user: User, vm_id: int) -> VM:
    vm = db.get(VM, vm_id)
    if not vm or (vm.owner_id != user.id and not is_admin(core.cfg, user)):
        raise HTTPException(404, "VM not found")
    return vm


def start_job(core: Core, db: Session, kind: str, vm: VM, user: User | None, fn) -> int:
    """Register + launch a background job for a VM. Commits the session."""
    try:
        job = core.create_job(db, kind, vm, user)
    except Busy as e:
        raise HTTPException(409, str(e)) from e
    core.audit(db, user, kind, f"{vm.cluster_id}/{vm.name}")
    db.commit()
    core.spawn_job(job.id, fn)
    return job.id


# -- session -------------------------------------------------------------


@router.get("/auth/config")
def auth_config(core: Core = Depends(get_core)):
    a = core.cfg.auth
    return {"app_name": core.cfg.app.name, "mode": a.mode,
            "dev_users": [{"username": u.username, "name": u.name or u.username, "groups": u.groups}
                          for u in a.dev_users] if a.mode == "dev" else []}


@router.get("/me")
def me(user: User = Depends(current_user), core: Core = Depends(get_core)):
    return {**user_out(user), "email": user.email, "groups": user.groups,
            "is_admin": is_admin(core.cfg, user), "ssh_public_key": user.ssh_public_key}


# -- clusters ------------------------------------------------------------


@router.get("/clusters")
async def clusters(user: User = Depends(current_user), core: Core = Depends(get_core)):
    out = []
    for c in core.cfg.clusters:
        if not can_use(core.cfg, user, c):
            continue
        try:
            nodes = await core.cached((c.id, "nodes"), core.driver(c.id).nodes, max_age=15)
            error = None
        except ProxmoxError as e:
            nodes, error = [], str(e)
        with core.Session() as db:
            used = vm_svc.usage(db, user.id, c.id)
        out.append({
            "id": c.id, "name": c.name, "kind": c.kind, "description": c.description,
            "approval": c.approval, "has_gpus": c.has_gpus, "gpu_count": len(c.gpu.devices),
            "has_backups": bool(c.backup_storage),
            "limits": c.limits.model_dump(), "quota": c.quota.model_dump(), "usage": used,
            "gpu_rules": {"max_reservation_hours": c.gpu.max_reservation_hours,
                          "max_advance_days": c.gpu.max_advance_days},
            "templates": [{"id": t.id, "name": t.name, "os": t.os, "description": t.description,
                           "default_user": t.default_user, "gpu_capable": t.gpu_capable} for t in c.templates],
            "nodes": nodes, "error": error,
        })
    return out


# -- VMs -----------------------------------------------------------------


class VMCreate(BaseModel):
    cluster_id: str
    name: str
    template_id: str
    cores: int = Field(ge=1)
    memory_mb: int = Field(ge=512)
    disk_gb: int = Field(ge=8)
    ssh_public_key: str = ""
    wants_gpu: bool = False
    justification: str = Field("", max_length=2000)


@router.get("/vms")
async def list_vms(scope: Literal["mine", "all"] = "mine", user: User = Depends(current_user),
                   core: Core = Depends(get_core)):
    if scope == "all" and not is_admin(core.cfg, user):
        raise HTTPException(403, "admins only")
    with core.Session() as db:
        q = select(VM).where(VM.status != "deleted").order_by(VM.created_at.desc())
        if scope == "mine":
            q = q.where(VM.owner_id == user.id)
        rows = list(db.scalars(q))
        lives = {cid: await live_view(core, cid) for cid in {v.cluster_id for v in rows}}
        return [vm_out(db, core, v, lives[v.cluster_id]) for v in rows]


@router.post("/vms", status_code=201)
async def create_vm(body: VMCreate, user: User = Depends(current_user), core: Core = Depends(get_core)):
    cluster = core.cfg.cluster(body.cluster_id)
    if not cluster or not can_use(core.cfg, user, cluster):
        raise HTTPException(404, "cluster not found")
    tpl = cluster.template(body.template_id)
    if not tpl:
        raise HTTPException(422, "unknown template")
    name = body.name.strip().lower()
    if not NAME.match(name):
        raise HTTPException(422, "name must be a hostname: lowercase letters, digits and dashes, up to 40 characters")
    key = body.ssh_public_key.strip()
    if tpl.os == "linux":
        if not key:
            raise HTTPException(422, "an SSH public key is required for Linux VMs")
        if any(not SSH_KEY.match(line.strip()) for line in key.splitlines() if line.strip()):
            raise HTTPException(422, "that does not look like an SSH public key")
    lim = cluster.limits
    if body.cores > lim.max_cores or body.memory_mb > lim.max_memory_mb or body.disk_gb > lim.max_disk_gb:
        raise HTTPException(422, f"over the per-VM limit ({lim.max_cores} cores, "
                                 f"{lim.max_memory_mb} MB, {lim.max_disk_gb} GB)")
    wants_gpu = body.wants_gpu and cluster.has_gpus and tpl.gpu_capable
    if cluster.approval == "required" and not body.justification.strip():
        raise HTTPException(422, "tell the approvers what the VM is for")

    with core.Session() as db:
        if db.scalar(select(VM.id).where(VM.cluster_id == cluster.id, VM.name == name, VM.status.in_(VM_LIVE))):
            raise HTTPException(409, f"a VM named {name} already exists on {cluster.name}")
        err = vm_svc.quota_error(cluster, vm_svc.usage(db, user.id, cluster.id),
                                 body.cores, body.memory_mb, body.disk_gb)
        if err:
            raise HTTPException(422, err)
        self_service = cluster.approval == "none"
        vm = VM(cluster_id=cluster.id, name=name, owner_id=user.id, template_id=tpl.id, cores=body.cores,
                memory_mb=body.memory_mb, disk_gb=body.disk_gb, ssh_public_key=key,
                justification=body.justification.strip(),
                status="provisioning" if self_service else "pending",
                # GPU access always needs an admin, even on self-service clusters.
                gpu_access="requested" if wants_gpu else "none")
        db.add(vm)
        if key:
            db.get(User, user.id).ssh_public_key = key
        db.flush()
        vm_id = vm.id
        if self_service:
            start_job(core, db, "provision", vm, user, lambda log: vm_svc.provision(core, vm_id, log))
        else:
            core.audit(db, user, "request-vm", f"{cluster.id}/{name}",
                       f"{body.cores}c/{body.memory_mb}MB/{body.disk_gb}GB gpu={wants_gpu}")
            db.commit()
        return vm_out(db, core, db.get(VM, vm_id), await live_view(core, cluster.id))


@router.get("/vms/{vm_id}")
async def vm_detail(vm_id: int, user: User = Depends(current_user), core: Core = Depends(get_core)):
    with core.Session() as db:
        vm = get_vm(db, core, user, vm_id)
        out = vm_out(db, core, vm, await live_view(core, vm.cluster_id))
        cluster = core.cfg.cluster(vm.cluster_id)
        tpl = cluster.template(vm.template_id) if cluster else None
        out["os"] = tpl.os if tpl else None
        out["ips"] = []
        if out["power"] == "running":
            try:
                out["ips"] = await core.cached(
                    (vm.cluster_id, "ips", vm.vmid),
                    lambda: core.driver(vm.cluster_id).vm_ips(out["node"], vm.vmid), max_age=20)
            except ProxmoxError:
                pass
        out["connections"] = connections(cluster, tpl, vm.name, out["ips"]) if out["power"] == "running" else []
        out["jobs"] = [job_out(j) for j in db.scalars(
            select(Job).where(Job.vm_id == vm.id).order_by(Job.id.desc()).limit(10))]
        out["reservations"] = [res_out(r) for r in db.scalars(
            select(Reservation).where(Reservation.vm_id == vm.id, Reservation.end_at > utcnow() - timedelta(days=7))
            .order_by(Reservation.start_at.desc()).limit(20))]
        out["backups"] = [{"id": b.id, "volid": b.volid, "notes": b.notes, "size": b.size,
                           "created_at": iso(b.created_at)}
                          for b in db.scalars(select(Backup).where(Backup.vm_id == vm.id).order_by(Backup.id.desc()))]
        return out


def connections(cluster, tpl, name: str, ips: list[str]) -> list[dict]:
    """How to reach a running VM over the network, per its template's `connect` list."""
    if not cluster:
        return []
    hosts = ([f"{name}.{cluster.connect_domain}"] if cluster.connect_domain else []) + ips
    if not hosts:
        return []
    host = hosts[0]
    user = tpl.default_user if tpl else ""
    out = []
    for kind in (tpl.connections if tpl else ["ssh"]):
        if kind == "ssh":
            out.append({"kind": "ssh", "label": "SSH", "host": host, "port": 22, "user": user,
                        "command": f"ssh {user}@{host}" if user else f"ssh {host}"})
        elif kind == "rdp":
            out.append({"kind": "rdp", "label": "Remote Desktop (RDP)", "host": host, "port": 3389,
                        # default_user's default is a Linux name; only show one set on purpose
                        "user": user if tpl and "default_user" in tpl.model_fields_set else "",
                        "command": f"{host}:3389"})
        elif kind == "sunshine":
            out.append({"kind": "sunshine", "label": "Moonlight (Sunshine)", "host": host, "port": 47989,
                        "user": "", "command": host, "url": f"https://{host}:47990"})
    for o in out:
        o["hosts"] = hosts
    return out


class PowerAction(BaseModel):
    action: Literal["start", "shutdown", "stop", "reboot"]


@router.post("/vms/{vm_id}/power")
async def vm_power(vm_id: int, body: PowerAction, user: User = Depends(current_user),
                   core: Core = Depends(get_core)):
    with core.Session() as db:
        vm = get_vm(db, core, user, vm_id)
        if vm.status != "active":
            raise HTTPException(409, "the VM is not active")
        return {"job_id": start_job(core, db, body.action, vm, user,
                                    lambda log: vm_svc.power(core, vm_id, body.action, log))}


@router.post("/vms/{vm_id}/console")
async def vm_console(vm_id: int, user: User = Depends(current_user), core: Core = Depends(get_core)):
    """Open the VM's screen. Returns a one-time token for the console websocket."""
    with core.Session() as db:
        vm = get_vm(db, core, user, vm_id)
        if vm.status != "active":
            raise HTTPException(409, "the VM is not active")
        live = await vm_svc.locate(core, vm)
        if not live or live["status"] != "running":
            raise HTTPException(409, "start the VM to open its console")
        stream = await core.driver(vm.cluster_id).open_console(live["node"], vm.vmid)
        core.audit(db, user, "console", f"{vm.cluster_id}/{vm.name}")
        db.commit()
        return {"token": core.hold_console(user.id, stream), "password": stream.password, "name": vm.name}


@router.websocket("/console/{token}")
async def console_ws(ws: WebSocket, token: str):
    core: Core = ws.app.state.core
    # Browsers send cookies on cross-site websockets, so pin the origin too.
    origin = ws.headers.get("origin")
    allowed = {urlsplit(core.cfg.app.base_url).netloc, ws.headers.get("host")}
    stream = None
    if not origin or urlsplit(origin).netloc in allowed:
        stream = core.claim_console(token, ws.session.get("uid"))
    if not stream:
        await ws.close(code=4403)
        return
    await ws.accept(subprotocol="binary" if "binary" in ws.scope.get("subprotocols", []) else None)

    async def downstream():
        while (data := await stream.recv()) is not None:
            await ws.send_bytes(data)

    async def upstream():
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            data = msg.get("bytes") or (msg.get("text") or "").encode()
            if data:
                await stream.send(data)

    tasks = [asyncio.ensure_future(downstream()), asyncio.ensure_future(upstream())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await stream.close()
        try:
            await ws.close()
        except (RuntimeError, WebSocketDisconnect):
            pass  # already closed by the browser


@router.delete("/vms/{vm_id}")
async def vm_delete(vm_id: int, user: User = Depends(current_user), core: Core = Depends(get_core)):
    with core.Session() as db:
        vm = get_vm(db, core, user, vm_id)
        if vm.status in ("pending", "rejected", "archived") or (vm.status == "error" and vm.vmid is None):
            # Nothing exists on the cluster (archives stay in PBS until pruned).
            vm.status = "deleted"
            core.audit(db, user, "delete", f"{vm.cluster_id}/{vm.name}")
            db.commit()
            return {"job_id": None}
        if vm.status not in ("active", "error"):
            raise HTTPException(409, f"cannot delete a VM that is {vm.status}")
        return {"job_id": start_job(core, db, "destroy", vm, user, lambda log: vm_svc.destroy(core, vm_id, log))}


@router.post("/vms/{vm_id}/gpu-access")
def request_gpu_access(vm_id: int, body: dict, user: User = Depends(current_user), core: Core = Depends(get_core)):
    with core.Session() as db:
        vm = get_vm(db, core, user, vm_id)
        cluster = core.cfg.cluster(vm.cluster_id)
        if not cluster or not cluster.has_gpus:
            raise HTTPException(409, "this cluster has no GPUs")
        if vm.status not in ("pending", "active") or vm.gpu_access != "none":
            raise HTTPException(409, "GPU access was already requested for this VM")
        reason = str(body.get("justification", "")).strip()[:2000]
        if not reason:
            raise HTTPException(422, "tell the approvers what the GPU is for")
        vm.gpu_access = "requested"
        vm.justification = (vm.justification + "\n\nGPU: " + reason).strip()
        core.audit(db, user, "request-gpu-access", f"{vm.cluster_id}/{vm.name}", reason)
        db.commit()
    return {"ok": True}


# -- backups -------------------------------------------------------------


def _backup_cluster(core: Core, vm: VM):
    cluster = core.cfg.cluster(vm.cluster_id)
    if not cluster or not cluster.backup_storage:
        raise HTTPException(409, "backups are not configured for this cluster")
    return cluster


@router.post("/vms/{vm_id}/backups")
async def vm_backup(vm_id: int, body: dict, user: User = Depends(current_user), core: Core = Depends(get_core)):
    with core.Session() as db:
        vm = get_vm(db, core, user, vm_id)
        _backup_cluster(core, vm)
        if vm.status != "active":
            raise HTTPException(409, "the VM is not active")
        notes = str(body.get("notes", "")).strip()[:200]
        return {"job_id": start_job(core, db, "backup", vm, user,
                                    lambda log: backup_svc.backup(core, vm_id, notes, log))}


@router.post("/vms/{vm_id}/archive")
async def vm_archive(vm_id: int, user: User = Depends(current_user), core: Core = Depends(get_core)):
    with core.Session() as db:
        vm = get_vm(db, core, user, vm_id)
        _backup_cluster(core, vm)
        if vm.status != "active":
            raise HTTPException(409, "the VM is not active")
        return {"job_id": start_job(core, db, "archive", vm, user, lambda log: backup_svc.archive(core, vm_id, log))}


@router.post("/vms/{vm_id}/restore")
async def vm_restore(vm_id: int, body: dict, user: User = Depends(current_user), core: Core = Depends(get_core)):
    with core.Session() as db:
        vm = get_vm(db, core, user, vm_id)
        cluster = _backup_cluster(core, vm)
        if vm.status not in ("active", "archived"):
            raise HTTPException(409, f"cannot restore a VM that is {vm.status}")
        # Only backups the portal recorded for this VM - never trust a client-supplied volid.
        bk = db.scalar(select(Backup).where(Backup.vm_id == vm.id, Backup.id == body.get("backup_id")))
        if not bk:
            raise HTTPException(404, "backup not found")
        if vm.status == "archived":
            # Coming back from the archive counts against quota again.
            err = vm_svc.quota_error(cluster, vm_svc.usage(db, vm.owner_id, cluster.id),
                                     vm.cores, vm.memory_mb, vm.disk_gb)
            if err and not is_admin(core.cfg, user):
                raise HTTPException(422, err)
        volid = bk.volid
        return {"job_id": start_job(core, db, "restore", vm, user,
                                    lambda log: backup_svc.restore(core, vm_id, volid, log))}


# -- GPUs and bookings ---------------------------------------------------


@router.get("/gpus")
async def list_gpus(user: User = Depends(current_user), core: Core = Depends(get_core)):
    out = []
    for c in core.cfg.clusters:
        if not c.has_gpus or not can_use(core.cfg, user, c):
            continue
        live = await live_view(core, c.id)
        with core.Session() as db:
            managed = {v.vmid: v for v in db.scalars(select(VM).where(
                VM.cluster_id == c.id, VM.status == "active", VM.vmid.is_not(None)))}
            active = {r.vm_id: r for r in db.scalars(select(Reservation).where(
                Reservation.cluster_id == c.id, Reservation.status == "active"))}
            devices = []
            for g in live["gpus"]:
                holder = None
                if g["holder"]:
                    vm = managed.get(g["holder"]["vmid"])
                    res = active.get(vm.id) if vm else None
                    holder = {"vmid": g["holder"]["vmid"], "name": g["holder"]["name"],
                              "power": g["holder"]["status"], "vm_id": vm.id if vm else None,
                              "owner": user_out(vm.owner) if vm else None,
                              "booked_until": iso(res.end_at) if res else None}
                devices.append({"id": g["id"], "node": g["node"], "model": g["model"], "holder": holder})
        out.append({"cluster_id": c.id, "cluster_name": c.name, "devices": devices, "error": live["error"]})
    return out


@router.get("/reservations")
def list_reservations(cluster_id: str, start: datetime, end: datetime,
                      user: User = Depends(current_user), core: Core = Depends(get_core)):
    cluster = core.cfg.cluster(cluster_id)
    if not cluster or not can_use(core.cfg, user, cluster):
        raise HTTPException(404, "cluster not found")
    with core.Session() as db:
        return [res_out(r) for r in db.scalars(select(Reservation).where(
            Reservation.cluster_id == cluster_id, Reservation.status != "cancelled",
            Reservation.start_at < to_utc(end), Reservation.end_at > to_utc(start)).order_by(Reservation.start_at))]


class Booking(BaseModel):
    vm_id: int
    start_at: datetime
    end_at: datetime
    note: str = Field("", max_length=200)


@router.post("/reservations", status_code=201)
def create_reservation(body: Booking, user: User = Depends(current_user), core: Core = Depends(get_core)):
    with core.Session() as db:
        vm = get_vm(db, core, user, body.vm_id)
        cluster = core.cluster(vm.cluster_id)
        now = utcnow()
        start, end = max(to_utc(body.start_at), now), to_utc(body.end_at)
        err = schedule.booking_error(db, cluster, vm, start, end, now)
        if err:
            raise HTTPException(422, err)
        r = Reservation(cluster_id=cluster.id, vm_id=vm.id, user_id=user.id, start_at=start, end_at=end,
                        note=body.note.strip())
        db.add(r)
        core.audit(db, user, "book-gpu", f"{cluster.id}/{vm.name}", f"{iso(start)} - {iso(end)}")
        db.commit()
        core.scheduler_kick.set()
        return res_out(r)


@router.delete("/reservations/{res_id}")
def cancel_reservation(res_id: int, user: User = Depends(current_user), core: Core = Depends(get_core)):
    with core.Session() as db:
        r = db.get(Reservation, res_id)
        if not r or (r.user_id != user.id and r.vm.owner_id != user.id and not is_admin(core.cfg, user)):
            raise HTTPException(404, "booking not found")
        if r.status == "scheduled":
            r.status = "cancelled"
        elif r.status == "active":
            r.end_at = utcnow()  # the scheduler releases the GPU on its next pass
        else:
            raise HTTPException(409, f"booking is already {r.status}")
        core.audit(db, user, "cancel-booking", f"{r.cluster_id}/{r.vm.name}", f"#{r.id}")
        db.commit()
    core.scheduler_kick.set()
    return {"ok": True}


# -- jobs ----------------------------------------------------------------


@router.get("/jobs")
def list_jobs(scope: Literal["mine", "all"] = "mine", limit: int = Query(50, le=200),
              user: User = Depends(current_user), core: Core = Depends(get_core)):
    with core.Session() as db:
        q = select(Job).order_by(Job.id.desc()).limit(limit)
        if scope == "all" and is_admin(core.cfg, user):
            pass
        else:
            q = q.outerjoin(VM, Job.vm_id == VM.id).where((Job.user_id == user.id) | (VM.owner_id == user.id))
        return [job_out(j) for j in db.scalars(q)]


# -- admin ---------------------------------------------------------------


class Review(BaseModel):
    approve: bool
    grant_gpu: bool = False
    note: str = Field("", max_length=1000)


@router.get("/admin/approvals")
async def approvals(admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    with core.Session() as db:
        rows = list(db.scalars(select(VM).where(
            (VM.status == "pending") | ((VM.status == "active") & (VM.gpu_access == "requested")))
            .order_by(VM.created_at)))
        lives = {cid: await live_view(core, cid) for cid in {v.cluster_id for v in rows}}
        return [vm_out(db, core, v, lives[v.cluster_id]) for v in rows]


@router.post("/admin/vms/{vm_id}/review")
async def review_vm(vm_id: int, body: Review, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    """Decide a pending VM request, or a GPU-access request on an existing VM."""
    with core.Session() as db:
        vm = db.get(VM, vm_id)
        if not vm:
            raise HTTPException(404, "VM not found")
        target = f"{vm.cluster_id}/{vm.name}"
        vm.review_note, vm.reviewed_by_id = body.note.strip(), admin.id
        if vm.status == "pending":
            if not body.approve:
                vm.status = "rejected"
                vm.gpu_access = "none"
                core.audit(db, admin, "reject-vm", target, body.note)
                db.commit()
                return {"job_id": None}
            if not core.cfg.cluster(vm.cluster_id):
                raise HTTPException(409, "the cluster is no longer configured")
            vm.status = "provisioning"
            if vm.gpu_access == "requested":
                vm.gpu_access = "approved" if body.grant_gpu else "none"
            core.audit(db, admin, "approve-vm", target, f"gpu={vm.gpu_access} {body.note}")
            return {"job_id": start_job(core, db, "provision", vm, admin,
                                        lambda log: vm_svc.provision(core, vm_id, log))}
        if vm.status == "active" and vm.gpu_access == "requested":
            vm.gpu_access = "approved" if body.approve else "none"
            core.audit(db, admin, "approve-gpu-access" if body.approve else "reject-gpu-access", target, body.note)
            db.commit()
            return {"job_id": None}
        raise HTTPException(409, "nothing to review on this VM")


class GpuAccess(BaseModel):
    allowed: bool


@router.post("/admin/vms/{vm_id}/gpu-access")
def set_gpu_access(vm_id: int, body: GpuAccess, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    with core.Session() as db:
        vm = db.get(VM, vm_id)
        if not vm:
            raise HTTPException(404, "VM not found")
        vm.gpu_access = "approved" if body.allowed else "none"
        core.audit(db, admin, "set-gpu-access", f"{vm.cluster_id}/{vm.name}", vm.gpu_access)
        db.commit()
    return {"ok": True}


class GpuAssign(BaseModel):
    vm_id: int
    gpu_id: str | None = None


@router.post("/admin/gpus/assign")
async def gpu_assign(body: GpuAssign, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    """Give a VM a GPU right now, taking it from the current holder if needed."""
    with core.Session() as db:
        vm = db.get(VM, body.vm_id)
        if not vm or vm.status != "active":
            raise HTTPException(404, "VM not found or not active")
        cluster = core.cluster(vm.cluster_id)
        if body.gpu_id and not cluster.gpu_device(body.gpu_id):
            raise HTTPException(404, "GPU not found")
        vmid = vm.vmid

        async def run(log):
            await gpu_svc.attach(core, cluster, vmid, log, gpu_id=body.gpu_id)

        return {"job_id": start_job(core, db, "gpu-attach", vm, admin, run)}


class GpuRelease(BaseModel):
    cluster_id: str
    vmid: int
    restart: bool = True


@router.post("/admin/gpus/release")
async def gpu_release(body: GpuRelease, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    """Detach the GPU from any VM on the cluster, portal-managed or not."""
    cluster = core.cfg.cluster(body.cluster_id)
    if not cluster or not cluster.has_gpus:
        raise HTTPException(404, "cluster not found")
    with core.Session() as db:
        vm = db.scalar(select(VM).where(VM.cluster_id == cluster.id, VM.vmid == body.vmid, VM.status == "active"))

        async def run(log):
            await gpu_svc.detach(core, cluster, body.vmid, log, restart=body.restart)

        if vm:
            return {"job_id": start_job(core, db, "gpu-release", vm, admin, run)}
        job = core.create_job(db, "gpu-release", None, admin)
        core.audit(db, admin, "gpu-release", f"{cluster.id}/vmid-{body.vmid}")
        db.commit()
        core.spawn_job(job.id, run)
        return {"job_id": job.id}


class Adopt(BaseModel):
    cluster_id: str
    vmid: int
    owner: str
    gpu_access: bool = False


@router.get("/admin/unmanaged")
async def unmanaged(cluster_id: str, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    """VMs on the cluster that the portal does not track yet."""
    cluster = core.cfg.cluster(cluster_id)
    if not cluster:
        raise HTTPException(404, "cluster not found")
    try:
        live = await core.live_vms(cluster_id)
    except ProxmoxError as e:
        raise HTTPException(502, str(e)) from e
    with core.Session() as db:
        known = set(db.scalars(select(VM.vmid).where(VM.cluster_id == cluster_id, VM.status != "deleted",
                                                     VM.vmid.is_not(None))))
    return [{"vmid": v["vmid"], "name": v["name"], "node": v["node"], "status": v["status"]}
            for v in sorted(live.values(), key=lambda v: v["vmid"]) if not v["template"] and v["vmid"] not in known]


@router.post("/admin/vms/adopt", status_code=201)
async def adopt(body: Adopt, admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    """Bring an existing Proxmox VM under portal management for a user."""
    cluster = core.cfg.cluster(body.cluster_id)
    if not cluster:
        raise HTTPException(404, "cluster not found")
    try:
        drv = core.driver(cluster.id)
        live = await drv.find_vm(body.vmid)
        if not live or live["template"]:
            raise HTTPException(404, f"no VM {body.vmid} on {cluster.name}")
        config = await drv.vm_config(live["node"], body.vmid)
    except ProxmoxError as e:
        raise HTTPException(502, str(e)) from e
    from .proxmox.base import disk_key, disk_size_gb
    disk = disk_key(config)
    with core.Session() as db:
        owner = vm_svc.find_user(db, body.owner)
        if not owner:
            raise HTTPException(404, f"user {body.owner} has not signed in to the portal yet")
        if db.scalar(select(VM.id).where(VM.cluster_id == cluster.id, VM.vmid == body.vmid, VM.status != "deleted")):
            raise HTTPException(409, "that VM is already managed")
        vm = VM(cluster_id=cluster.id, vmid=body.vmid, name=live["name"] or f"vm-{body.vmid}", owner_id=owner.id,
                cores=int(config.get("cores", 1)) * int(config.get("sockets", 1)),
                memory_mb=int(str(config.get("memory", 0)).split(",")[0].replace("current=", "") or 0),
                disk_gb=int(disk_size_gb(str(config[disk]))) if disk else 0,
                status="active", gpu_access="approved" if body.gpu_access else "none",
                justification="adopted", reviewed_by_id=admin.id)
        db.add(vm)
        core.audit(db, admin, "adopt-vm", f"{cluster.id}/{vm.name}", f"vmid={body.vmid} owner={owner.username}")
        db.commit()
        return {"id": vm.id}


@router.get("/admin/users")
def users(admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    with core.Session() as db:
        return [{**user_out(u), "email": u.email, "groups": u.groups, "last_login_at": iso(u.last_login_at)}
                for u in db.scalars(select(User).order_by(User.username))]


@router.get("/admin/audit")
def audit(limit: int = Query(200, le=1000), admin: User = Depends(require_admin), core: Core = Depends(get_core)):
    with core.Session() as db:
        return [{"id": a.id, "at": iso(a.at), "user": user_out(a.user), "action": a.action,
                 "target": a.target, "detail": a.detail}
                for a in db.scalars(select(Audit).order_by(Audit.id.desc()).limit(limit))]
