"""GPU bookings: validation and the loop that attaches/detaches GPUs on time."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import ClusterConfig
from ..core import Core
from ..db import VM, Job, Reservation, utcnow
from . import gpus

log = logging.getLogger("macs.schedule")
OPEN = ("scheduled", "active")


def booking_error(db: Session, cluster: ClusterConfig, vm: VM, start: datetime, end: datetime,
                  now: datetime | None = None) -> str | None:
    now = now or utcnow()
    g = cluster.gpu
    if not cluster.has_gpus:
        return f"{cluster.name} has no GPUs"
    if vm.status != "active":
        return "the VM is not active"
    if vm.gpu_access != "approved":
        return "this VM is not approved for GPU use"
    if end <= start:
        return "the booking must end after it starts"
    if end <= now:
        return "the booking is in the past"
    if end - start > timedelta(hours=g.max_reservation_hours):
        return f"bookings are limited to {g.max_reservation_hours} hours"
    if start > now + timedelta(days=g.max_advance_days):
        return f"bookings can be made at most {g.max_advance_days} days ahead"

    overlapping = list(db.scalars(select(Reservation).where(
        Reservation.cluster_id == cluster.id, Reservation.status.in_(OPEN),
        Reservation.start_at < end, Reservation.end_at > start)))
    if any(r.vm_id == vm.id for r in overlapping):
        return "this VM already has a booking overlapping that time"
    # Peak concurrency only changes where a booking starts, so check those instants.
    for t in [start] + [r.start_at for r in overlapping if r.start_at > start]:
        if sum(1 for r in overlapping if r.start_at <= t < r.end_at) >= len(g.devices):
            return f"all {len(g.devices)} GPUs are booked at {t.strftime('%Y-%m-%d %H:%M')} UTC"
    return None


async def _finish(core: Core, res_id: int) -> None:
    with core.Session.begin() as db:
        r = db.get(Reservation, res_id)
        vm = r.vm
        now = utcnow()
        # Back-to-back booking for the same VM: hand the GPU straight over.
        nxt = db.scalar(select(Reservation).where(
            Reservation.vm_id == vm.id, Reservation.status == "scheduled",
            Reservation.start_at <= now, Reservation.end_at > now))
        if nxt:
            r.status, nxt.status, nxt.gpu_id = "completed", "active", r.gpu_id
            return
        if vm.status != "active" or vm.vmid is None:
            r.status = "completed"
            return
        if core.vm_busy(db, vm.id):
            return  # retry next tick
        job = core.create_job(db, "gpu-release", vm, None)
        job_id, vmid = job.id, vm.vmid
    cluster = core.cluster(vm.cluster_id)

    async def run(write):
        write(f"booking #{res_id} ended")
        await gpus.detach(core, cluster, vmid, write, restart=True)

    ok = await core.run_job(job_id, run)
    with core.Session.begin() as db:
        r = db.get(Reservation, res_id)
        # Even if the release failed the booking is over; an unbooked holder is
        # preemptible, so the next booking will still get the GPU.
        r.status = "completed"
        if not ok:
            r.error = "GPU release failed - see the job log"


async def _begin(core: Core, res_id: int) -> None:
    with core.Session.begin() as db:
        r = db.get(Reservation, res_id)
        vm = r.vm
        if r.end_at <= utcnow():
            r.status, r.error = "failed", "the booking window passed before it could start"
            return
        if vm.status != "active" or vm.vmid is None:
            r.status, r.error = "failed", "the VM is no longer active"
            return
        if core.vm_busy(db, vm.id):
            return
        job = core.create_job(db, "gpu-attach", vm, None)
        job_id, vmid = job.id, vm.vmid
    cluster = core.cluster(vm.cluster_id)
    got: dict = {}

    async def run(write):
        write(f"booking #{res_id} starting")
        got["gpu"] = await gpus.attach(core, cluster, vmid, write, preempt=True)

    ok = await core.run_job(job_id, run)
    with core.Session.begin() as db:
        r = db.get(Reservation, res_id)
        if r.status != "scheduled":
            return  # cancelled while attaching; the next tick reconciles
        if ok:
            r.status, r.gpu_id = "active", got["gpu"]
        else:
            r.status, r.error = "failed", db.get(Job, job_id).error


async def tick(core: Core) -> None:
    async with core.tick_lock:
        now = utcnow()
        with core.Session() as db:
            ending = list(db.scalars(select(Reservation.id).where(
                Reservation.status == "active", Reservation.end_at <= now)))
        for res_id in ending:  # free GPUs before handing them out
            await _finish(core, res_id)
        with core.Session() as db:
            starting = list(db.scalars(select(Reservation.id).where(
                Reservation.status == "scheduled", Reservation.start_at <= now).order_by(Reservation.start_at)))
        for res_id in starting:
            await _begin(core, res_id)


async def run_forever(core: Core) -> None:
    while True:
        try:
            await tick(core)
        except Exception:  # noqa: BLE001 - the loop must survive anything
            log.exception("scheduler tick failed")
        core.scheduler_kick.clear()
        try:
            await asyncio.wait_for(core.scheduler_kick.wait(), core.cfg.app.scheduler_interval_seconds)
        except asyncio.TimeoutError:
            pass
