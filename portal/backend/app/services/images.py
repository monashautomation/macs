"""The image library: Proxmox templates and install ISOs users can deploy from."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Config
from ..db import Image


def seed(cfg: Config, db: Session) -> None:
    """Add images listed in config.yaml that the library does not have yet.
    Existing entries are left alone so edits made in the portal stick."""
    for cluster in cfg.clusters:
        have = set(db.scalars(select(Image.slug).where(Image.cluster_id == cluster.id)))
        for t in cluster.templates:
            if t.id in have:
                continue
            db.add(Image(cluster_id=cluster.id, slug=t.id, kind=t.kind, name=t.name, description=t.description,
                         os=t.os, vmid=t.vmid, volid=t.volid, cicustom=t.cicustom, gpu_ready=t.gpu_ready,
                         tags=t.tags, connect=t.connect,
                         default_user=t.default_user or ("ubuntu" if t.os == "linux" and t.kind == "template" else "")))


def get(db: Session, cluster_id: str, slug: str) -> Image | None:
    return db.scalar(select(Image).where(Image.cluster_id == cluster_id, Image.slug == slug))


def connect_kinds(image: Image | None) -> list[str]:
    if image is None:
        return ["ssh"]
    if image.connect is not None:
        return image.connect
    return ["rdp"] if image.os == "windows" else ["ssh"]


def out(image: Image, admin: bool = False) -> dict:
    data = {"id": image.slug, "name": image.name, "kind": image.kind, "os": image.os,
            "description": image.description, "default_user": image.default_user,
            "gpu_ready": image.gpu_ready, "tags": image.tags or []}
    if admin:
        data.update(db_id=image.id, cluster_id=image.cluster_id, vmid=image.vmid, volid=image.volid,
                    cicustom=image.cicustom, connect=image.connect, enabled=image.enabled)
    return data
