from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from . import api, api_infra, auth
from .config import Config, get_config
from .core import Core
from .proxmox.base import ProxmoxError
from .services import schedule


def create_app(cfg: Config | None = None, core: Core | None = None, run_scheduler: bool = True) -> FastAPI:
    cfg = cfg or get_config()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.core = core or Core(cfg)
        app.state.core.recover()
        task = asyncio.create_task(schedule.run_forever(app.state.core)) if run_scheduler else None
        yield
        if task:
            task.cancel()
        await app.state.core.close()

    app = FastAPI(title=f"{cfg.app.name} portal", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.add_middleware(SessionMiddleware, secret_key=cfg.app.secret_key, session_cookie="macs_session",
                       same_site="lax", https_only=cfg.app.base_url.startswith("https://"), max_age=12 * 3600)
    if cfg.auth.mode == "oidc":
        app.state.oauth = auth._oauth(cfg)
    app.include_router(auth.router)
    app.include_router(api.router)
    app.include_router(api_infra.router)

    @app.exception_handler(ProxmoxError)
    async def proxmox_error(_: Request, exc: ProxmoxError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    # Serve the built single-page app, falling back to index.html for client routes.
    static = Path(os.environ.get("MACS_STATIC_DIR", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
    if static.is_dir():
        app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith(("api/", "auth/")):
                raise HTTPException(404)
            file = (static / path).resolve()
            if path and file.is_file() and static.resolve() in file.parents:
                return FileResponse(file)
            return FileResponse(static / "index.html")

    return app


def app() -> FastAPI:
    """uvicorn entry point: `uvicorn app.main:app --factory`."""
    return create_app()
