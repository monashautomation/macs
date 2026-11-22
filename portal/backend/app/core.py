"""Process-wide state: config, DB sessions, Proxmox drivers, background jobs."""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections import defaultdict
from typing import Any, Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from .config import ClusterConfig, Config
from .db import VM, Audit, Job, User, make_session_factory, utcnow
from .proxmox.base import ConsoleStream, ProxmoxDriver
from .proxmox.client import ProxmoxClient
from .proxmox.mock import MockProxmox

log = logging.getLogger("macs")

Log = Callable[[str], None]


class Busy(Exception):
    """The VM already has an operation in flight."""


class Core:
    def __init__(self, cfg: Config, session_factory: sessionmaker | None = None,
                 drivers: dict[str, ProxmoxDriver] | None = None):
        self.cfg = cfg
        self.Session = session_factory or make_session_factory(cfg.app.database_url)
        self.drivers: dict[str, ProxmoxDriver] = drivers or {
            c.id: (MockProxmox(c, delay=0.6, demo=True) if c.driver == "mock" else ProxmoxClient(c)) for c in cfg.clusters}
        from .services import images
        with self.Session.begin() as db:
            images.seed(cfg, db)
        self.gpu_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.provision_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.scheduler_kick = asyncio.Event()
        self.tick_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()
        # Opened console streams waiting for the browser's websocket: token -> (user id, stream)
        self._consoles: dict[str, tuple[int, ConsoleStream]] = {}
        self._cache: dict[tuple, tuple[float, Any]] = {}

    def cluster(self, cluster_id: str) -> ClusterConfig:
        c = self.cfg.cluster(cluster_id)
        if not c:
            raise KeyError(f"unknown cluster {cluster_id}")
        return c

    def driver(self, cluster_id: str) -> ProxmoxDriver:
        return self.drivers[cluster_id]

    # -- short-lived cache for live Proxmox reads ------------------------

    async def cached(self, key: tuple, fetch: Callable[[], Awaitable[Any]], max_age: float = 5.0) -> Any:
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < max_age:
            return hit[1]
        value = await fetch()
        self._cache[key] = (time.monotonic(), value)
        return value

    def invalidate(self, cluster_id: str) -> None:
        for key in [k for k in self._cache if k[0] == cluster_id]:
            del self._cache[key]

    async def live_vms(self, cluster_id: str) -> dict[int, dict[str, Any]]:
        async def fetch():
            return {v["vmid"]: v for v in await self.driver(cluster_id).vms()}
        return await self.cached((cluster_id, "vms"), fetch)

    # -- consoles --------------------------------------------------------

    def hold_console(self, user_id: int, stream: ConsoleStream, ttl: float = 20.0) -> str:
        """Park an open console until its owner's websocket claims it (once)."""
        token = secrets.token_urlsafe(32)
        self._consoles[token] = (user_id, stream)

        def expire() -> None:
            entry = self._consoles.pop(token, None)
            if entry:
                asyncio.ensure_future(entry[1].close())

        asyncio.get_running_loop().call_later(ttl, expire)
        return token

    def claim_console(self, token: str, user_id: int | None) -> ConsoleStream | None:
        entry = self._consoles.get(token)
        if not entry or entry[0] != user_id:
            return None
        del self._consoles[token]
        return entry[1]

    # -- audit + jobs ----------------------------------------------------

    def audit(self, db: Session, user: User | None, action: str, target: str = "", detail: str = "") -> None:
        db.add(Audit(user_id=user.id if user else None, action=action, target=target, detail=detail))

    def vm_busy(self, db: Session, vm_id: int) -> bool:
        return db.scalar(select(Job.id).where(Job.vm_id == vm_id, Job.status == "running").limit(1)) is not None

    def create_job(self, db: Session, kind: str, vm: VM | None, user: User | None) -> Job:
        """Registers a job; raises Busy if the VM already has one running. Caller commits."""
        if vm is not None and self.vm_busy(db, vm.id):
            raise Busy(f"{vm.name} already has an operation in progress")
        job = Job(kind=kind, vm_id=vm.id if vm else None, user_id=user.id if user else None)
        db.add(job)
        db.flush()
        return job

    async def run_job(self, job_id: int, fn: Callable[[Log], Awaitable[None]]) -> bool:
        """Runs fn, streaming its log lines into the job row. Returns success."""
        def write(msg: str) -> None:
            with self.Session.begin() as db:
                job = db.get(Job, job_id)
                job.log += f"{utcnow().strftime('%H:%M:%S')} {msg}\n"

        error = ""
        try:
            await fn(write)
        except Exception as e:  # noqa: BLE001 - surface every failure on the job
            log.exception("job %s failed", job_id)
            error = str(e) or type(e).__name__
            write(f"FAILED: {error}")
        with self.Session.begin() as db:
            job = db.get(Job, job_id)
            job.status = "failed" if error else "succeeded"
            job.error = error
            job.finished_at = utcnow()
            if job.vm_id:
                vm = db.get(VM, job.vm_id)
                self.invalidate(vm.cluster_id)
        return not error

    def spawn_job(self, job_id: int, fn: Callable[[Log], Awaitable[None]]) -> None:
        task = asyncio.get_running_loop().create_task(self.run_job(job_id, fn))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def wait_jobs(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    def recover(self) -> None:
        """Called at startup: nothing survives a restart, so close out orphans."""
        with self.Session.begin() as db:
            for job in db.scalars(select(Job).where(Job.status == "running")):
                job.status, job.error, job.finished_at = "failed", "interrupted by a portal restart", utcnow()
            for vm in db.scalars(select(VM).where(VM.status == "provisioning")):
                vm.status, vm.error = "error", "provisioning was interrupted by a portal restart"

    async def close(self) -> None:
        for d in self.drivers.values():
            await d.close()
