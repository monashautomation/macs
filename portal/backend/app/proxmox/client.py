"""Thin async client for the Proxmox VE REST API."""
from __future__ import annotations

import asyncio
import ssl
import time
from typing import Any
from urllib.parse import quote

import httpx
import websockets

from ..config import ClusterConfig
from .base import ConsoleStream, ProxmoxDriver, ProxmoxError


class _WebSocketConsole(ConsoleStream):
    def __init__(self, ws, password: str):
        self._ws = ws
        self.password = password

    async def recv(self) -> bytes | None:
        try:
            data = await self._ws.recv()
        except websockets.ConnectionClosed:
            return None
        return data.encode() if isinstance(data, str) else data

    async def send(self, data: bytes) -> None:
        try:
            await self._ws.send(data)
        except websockets.ConnectionClosed:
            pass

    async def close(self) -> None:
        await self._ws.close()


class ProxmoxClient(ProxmoxDriver):
    def __init__(self, cfg: ClusterConfig, task_timeout: int = 1800):
        self.cfg = cfg
        self.task_timeout = task_timeout
        self._http = httpx.AsyncClient(
            base_url=cfg.endpoint.rstrip("/") + "/api2/json",
            verify=cfg.verify_tls,
            timeout=httpx.Timeout(60, connect=10),
        )
        self._ticket: tuple[float, dict[str, str]] | None = None
        self._auth_lock = asyncio.Lock()

    async def close(self) -> None:
        await self._http.aclose()

    async def _auth(self) -> dict[str, str]:
        """Returns the auth headers for a request."""
        if self.cfg.token_id:
            return {"Authorization": f"PVEAPIToken={self.cfg.token_id}={self.cfg.token_secret}"}
        async with self._auth_lock:
            # Tickets last 2h; refresh after 1h.
            if self._ticket and time.monotonic() - self._ticket[0] < 3600:
                return self._ticket[1]
            try:
                r = await self._http.post("/access/ticket", data={
                    "username": self.cfg.username, "password": self.cfg.password})
            except httpx.HTTPError as e:
                raise ProxmoxError(f"{self.cfg.id}: cannot reach Proxmox: {e}") from e
            if r.status_code != 200:
                raise ProxmoxError(f"{self.cfg.id}: Proxmox login failed ({r.status_code})")
            d = r.json()["data"]
            self._ticket = (time.monotonic(), {"CSRFPreventionToken": d["CSRFPreventionToken"],
                                               "Cookie": f"PVEAuthCookie={quote(d['ticket'], safe='')}"})
            return self._ticket[1]

    async def _call(self, method: str, path: str, **params: Any) -> Any:
        headers = await self._auth()
        params = {k: (int(v) if isinstance(v, bool) else v) for k, v in params.items() if v is not None}
        kw: dict[str, Any] = {"params": params} if method in ("GET", "DELETE") else {"data": params}
        try:
            r = await self._http.request(method, path, headers=headers, **kw)
        except httpx.HTTPError as e:
            raise ProxmoxError(f"{self.cfg.id}: cannot reach Proxmox: {e or type(e).__name__}") from e
        if r.status_code >= 400:
            detail = r.reason_phrase
            try:
                body = r.json()
                if body.get("errors"):
                    detail += f" {body['errors']}"
                elif body.get("message"):
                    detail += f" {body['message']}"
            except ValueError:
                pass
            raise ProxmoxError(f"{method} {path}: {r.status_code} {detail}".strip())
        return r.json().get("data")

    async def _task(self, method: str, path: str, **params: Any) -> None:
        """Call an endpoint and, if it returned a task id, wait for the task."""
        upid = await self._call(method, path, **params)
        if not (isinstance(upid, str) and upid.startswith("UPID:")):
            return
        node = upid.split(":")[1]
        deadline = time.monotonic() + self.task_timeout
        while True:
            st = await self._call("GET", f"/nodes/{node}/tasks/{quote(upid, safe='')}/status")
            if st.get("status") == "stopped":
                exit_status = st.get("exitstatus", "")
                # Tasks that finish with warnings still did their job.
                if exit_status != "OK" and not exit_status.startswith("WARNINGS"):
                    raise ProxmoxError(f"{method} {path} failed: {exit_status}")
                return
            if time.monotonic() > deadline:
                raise ProxmoxError(f"{method} {path}: task timed out")
            await asyncio.sleep(2)

    # -- inventory -------------------------------------------------------

    async def nodes(self) -> list[dict[str, Any]]:
        return [{"node": n["node"], "status": n.get("status", "unknown"),
                 "cpu": n.get("cpu", 0), "maxcpu": n.get("maxcpu", 0),
                 "mem": n.get("mem", 0), "maxmem": n.get("maxmem", 0)}
                for n in await self._call("GET", "/nodes")]

    async def vms(self) -> list[dict[str, Any]]:
        res = await self._call("GET", "/cluster/resources", type="vm")
        return [{"vmid": int(r["vmid"]), "name": r.get("name", ""), "node": r["node"],
                 "status": r.get("status", "unknown"), "template": bool(r.get("template")),
                 "tags": r.get("tags", ""), "cpu": r.get("cpu", 0), "maxcpu": r.get("maxcpu", 0),
                 "mem": r.get("mem", 0), "maxmem": r.get("maxmem", 0), "uptime": r.get("uptime", 0)}
                for r in res if r.get("type") == "qemu"]

    async def vm_config(self, node: str, vmid: int) -> dict[str, Any]:
        return await self._call("GET", f"/nodes/{node}/qemu/{vmid}/config")

    async def set_config(self, node: str, vmid: int, **params: Any) -> None:
        await self._call("PUT", f"/nodes/{node}/qemu/{vmid}/config", **params)

    # -- lifecycle -------------------------------------------------------

    async def clone(self, node, template_vmid, newid, name, storage, target=None) -> None:
        await self._task("POST", f"/nodes/{node}/qemu/{template_vmid}/clone", newid=newid, name=name,
                         full=1, storage=storage, target=target if target != node else None)

    async def resize_disk(self, node, vmid, disk, size_gb) -> None:
        await self._task("PUT", f"/nodes/{node}/qemu/{vmid}/resize", disk=disk, size=f"{size_gb}G")

    async def start(self, node, vmid) -> None:
        await self._task("POST", f"/nodes/{node}/qemu/{vmid}/status/start")

    async def shutdown(self, node, vmid, timeout=120) -> None:
        await self._task("POST", f"/nodes/{node}/qemu/{vmid}/status/shutdown", timeout=timeout, forceStop=1)

    async def stop(self, node, vmid) -> None:
        await self._task("POST", f"/nodes/{node}/qemu/{vmid}/status/stop")

    async def reboot(self, node, vmid) -> None:
        await self._task("POST", f"/nodes/{node}/qemu/{vmid}/status/reboot")

    async def migrate(self, node, vmid, target) -> None:
        await self._task("POST", f"/nodes/{node}/qemu/{vmid}/migrate", target=target, online=0)

    async def delete(self, node, vmid) -> None:
        await self._task("DELETE", f"/nodes/{node}/qemu/{vmid}", purge=1,
                         **{"destroy-unreferenced-disks": 1})

    async def vm_ips(self, node, vmid) -> list[str]:
        try:
            res = await self._call("GET", f"/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces")
        except ProxmoxError:
            return []  # guest agent not running (yet)
        ips = []
        for iface in (res or {}).get("result", []) or []:
            if iface.get("name", "").startswith(("lo", "docker", "br-", "veth")):
                continue
            for a in iface.get("ip-addresses", []):
                ip = a.get("ip-address", "")
                if ip and not ip.startswith(("127.", "fe80", "::1")):
                    ips.append(ip)
        return ips

    # -- backups ---------------------------------------------------------

    async def backups(self, node, storage, vmid) -> list[dict[str, Any]]:
        res = await self._call("GET", f"/nodes/{node}/storage/{storage}/content", content="backup", vmid=vmid)
        return sorted(({"volid": b["volid"], "ctime": b.get("ctime", 0), "size": b.get("size", 0),
                        "notes": b.get("notes", "")} for b in res), key=lambda b: b["ctime"])

    async def backup(self, node, vmid, storage, notes="", mode="snapshot") -> dict[str, Any]:
        before = {b["volid"] for b in await self.backups(node, storage, vmid)}
        await self._task("POST", f"/nodes/{node}/vzdump", vmid=vmid, storage=storage, mode=mode,
                         **{"notes-template": notes or None})
        new = [b for b in await self.backups(node, storage, vmid) if b["volid"] not in before]
        if not new:
            raise ProxmoxError("backup task finished but no new backup was found")
        return new[-1]

    async def restore(self, node, vmid, volid, storage, force=False) -> None:
        await self._task("POST", f"/nodes/{node}/qemu", vmid=vmid, archive=volid, storage=storage,
                         force=1 if force else None)

    # -- blank VMs, storage, firewall ------------------------------------

    async def create_vm(self, node, vmid, **params) -> None:
        await self._task("POST", f"/nodes/{node}/qemu", vmid=vmid, **params)

    async def storage_content(self, node, storage, content) -> list[dict[str, Any]]:
        res = await self._call("GET", f"/nodes/{node}/storage/{storage}/content", content=content)
        return sorted(({"volid": v["volid"], "size": v.get("size", 0)} for v in res), key=lambda v: v["volid"])

    async def firewall_set_options(self, node, vmid, **options) -> None:
        await self._call("PUT", f"/nodes/{node}/qemu/{vmid}/firewall/options", **options)

    async def firewall_rules(self, node, vmid) -> list[dict[str, Any]]:
        return await self._call("GET", f"/nodes/{node}/qemu/{vmid}/firewall/rules") or []

    async def firewall_add_rule(self, node, vmid, **rule) -> None:
        await self._call("POST", f"/nodes/{node}/qemu/{vmid}/firewall/rules", pos=0, enable=1, **rule)

    async def firewall_delete_rule(self, node, vmid, pos) -> None:
        await self._call("DELETE", f"/nodes/{node}/qemu/{vmid}/firewall/rules/{pos}")

    async def cluster_firewall_enabled(self) -> bool:
        return bool((await self._call("GET", "/cluster/firewall/options") or {}).get("enable"))

    # -- console ---------------------------------------------------------

    async def open_console(self, node, vmid) -> ConsoleStream:
        # vncproxy starts a short-lived VNC listener on the node; the websocket
        # must attach within a few seconds, using the same credentials.
        data = await self._call("POST", f"/nodes/{node}/qemu/{vmid}/vncproxy", websocket=1)
        base = self.cfg.endpoint.rstrip("/").replace("https://", "wss://", 1).replace("http://", "ws://", 1)
        url = (f"{base}/api2/json/nodes/{node}/qemu/{vmid}/vncwebsocket"
               f"?port={data['port']}&vncticket={quote(data['ticket'], safe='')}")
        ctx = None
        if url.startswith("wss://"):
            ctx = ssl.create_default_context()
            if not self.cfg.verify_tls:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
        try:
            ws = await websockets.connect(url, additional_headers=await self._auth(), ssl=ctx,
                                          subprotocols=["binary"], max_size=None, open_timeout=10)
        except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as e:
            raise ProxmoxError(f"{self.cfg.id}: could not open the console: {e or type(e).__name__}") from e
        return _WebSocketConsole(ws, data["ticket"])
