"""Sign-in via Authentik (OIDC) with a signed session cookie; dev mode for local use."""
from __future__ import annotations

from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from .config import ClusterConfig, Config
from .core import Core
from .db import User, utcnow

router = APIRouter()


def get_core(request: Request) -> Core:
    return request.app.state.core


def _oauth(cfg: Config) -> OAuth:
    oauth = OAuth()
    oauth.register(
        "authentik",
        server_metadata_url=cfg.auth.issuer.rstrip("/") + "/.well-known/openid-configuration",
        client_id=cfg.auth.client_id,
        client_secret=cfg.auth.client_secret,
        client_kwargs={"scope": cfg.auth.scopes},
    )
    return oauth


def _sign_in(core: Core, request: Request, sub: str, username: str, name: str, email: str, groups: list[str]) -> None:
    with core.Session.begin() as db:
        user = db.scalar(select(User).where(User.sub == sub))
        if not user:
            user = User(sub=sub, username=username)
            db.add(user)
        user.username, user.name, user.email = username, name, email
        user.groups, user.last_login_at = sorted(set(groups)), utcnow()
        db.flush()
        core.audit(db, user, "login")
        request.session.clear()
        request.session["uid"] = user.id


@router.get("/auth/login")
async def login(request: Request, core: Core = Depends(get_core)):
    if core.cfg.auth.mode != "oidc":
        return RedirectResponse("/")
    redirect_uri = core.cfg.app.base_url.rstrip("/") + "/auth/callback"
    return await request.app.state.oauth.authentik.authorize_redirect(request, redirect_uri)


@router.get("/auth/callback")
async def callback(request: Request, core: Core = Depends(get_core)):
    try:
        token = await request.app.state.oauth.authentik.authorize_access_token(request)
    except OAuthError as e:
        raise HTTPException(400, f"sign-in failed: {e.error}") from e
    claims = dict(token.get("userinfo") or {})
    groups = claims.get(core.cfg.auth.groups_claim)
    if groups is None:
        # Authentik can be configured to put groups only in the userinfo endpoint.
        claims.update(await request.app.state.oauth.authentik.userinfo(token=token))
        groups = claims.get(core.cfg.auth.groups_claim) or []
    username = claims.get("preferred_username") or claims.get("email") or claims["sub"]
    _sign_in(core, request, claims["sub"], username, claims.get("name", ""), claims.get("email", ""),
             [str(g) for g in groups])
    return RedirectResponse("/")


@router.get("/auth/dev-login")
async def dev_login(username: str, request: Request, core: Core = Depends(get_core)):
    if core.cfg.auth.mode != "dev":
        raise HTTPException(404)
    dev = next((u for u in core.cfg.auth.dev_users if u.username == username), None)
    if not dev:
        raise HTTPException(404, "no such dev user")
    _sign_in(core, request, f"dev:{dev.username}", dev.username, dev.name or dev.username, dev.email, dev.groups)
    return RedirectResponse("/")


@router.get("/auth/logout")
async def logout(request: Request, core: Core = Depends(get_core)):
    request.session.clear()
    if core.cfg.auth.mode == "oidc":
        meta = await request.app.state.oauth.authentik.load_server_metadata()
        if meta.get("end_session_endpoint"):
            return RedirectResponse(meta["end_session_endpoint"])
    return RedirectResponse("/")


# -- dependencies and permission helpers ---------------------------------


def current_user(request: Request, core: Core = Depends(get_core)) -> User:
    uid = request.session.get("uid")
    user = None
    if uid:
        with core.Session() as db:
            user = db.get(User, uid)
    if not user:
        raise HTTPException(401, "not signed in")
    # Blocks cross-site form posts: browsers cannot add a custom header without CORS.
    if request.method not in ("GET", "HEAD") and request.headers.get("x-macs") != "1":
        raise HTTPException(403, "missing X-MACS header")
    return user


def is_admin(cfg: Config, user: User) -> bool:
    return bool(set(user.groups) & set(cfg.auth.admin_groups))


def require_admin(user: User = Depends(current_user), core: Core = Depends(get_core)) -> User:
    if not is_admin(core.cfg, user):
        raise HTTPException(403, "admins only")
    return user


def can_use(cfg: Config, user: User, cluster: ClusterConfig) -> bool:
    return is_admin(cfg, user) or not cluster.allowed_groups or bool(set(user.groups) & set(cluster.allowed_groups))
