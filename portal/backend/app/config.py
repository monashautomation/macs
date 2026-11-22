"""Configuration: one YAML file (MACS_CONFIG, default ./config.yaml).

String values may reference environment variables as ${VAR} or ${VAR:-default}
so secrets stay out of the file.
"""
from __future__ import annotations

import os
import re
from functools import lru_cache
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, model_validator

_ENV = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


def _expand(value: Any) -> Any:
    if isinstance(value, str):
        def sub(m: re.Match) -> str:
            got = os.environ.get(m.group(1), m.group(2))
            if got is None:
                raise ValueError(f"config references unset environment variable {m.group(1)}")
            return got
        return _ENV.sub(sub, value)
    if isinstance(value, list):
        return [_expand(v) for v in value]
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    return value


class AppConfig(BaseModel):
    name: str = "MACS"
    base_url: str = "http://localhost:8000"
    secret_key: str
    database_url: str = "sqlite:///./macs.db"
    timezone: str = "Australia/Melbourne"
    scheduler_interval_seconds: int = 30


class DevUser(BaseModel):
    username: str
    name: str = ""
    email: str = ""
    groups: list[str] = []


class AuthConfig(BaseModel):
    mode: Literal["oidc", "dev"] = "oidc"
    # Authentik: https://auth.example.com/application/o/<app-slug>/
    issuer: str = ""
    client_id: str = ""
    client_secret: str = ""
    scopes: str = "openid profile email"
    groups_claim: str = "groups"
    admin_groups: list[str] = []
    dev_users: list[DevUser] = []

    @model_validator(mode="after")
    def _check(self):
        if self.mode == "oidc" and not (self.issuer and self.client_id and self.client_secret):
            raise ValueError("auth.mode=oidc needs issuer, client_id and client_secret")
        return self


class Template(BaseModel):
    id: str
    name: str
    vmid: int
    os: Literal["linux", "windows"] = "linux"
    description: str = ""
    default_user: str = "ubuntu"
    # Optional Proxmox cicustom value, e.g. "vendor=cephfs:snippets/macs-vendor.yaml"
    # (vendor-data merges with the generated user/ssh-key config).
    cicustom: str = ""
    gpu_capable: bool = True


class Limits(BaseModel):
    """Per-VM ceilings."""
    max_cores: int = 8
    max_memory_mb: int = 16384
    max_disk_gb: int = 100


class Quota(BaseModel):
    """Per-user totals across a cluster. 0 = unlimited."""
    max_vms: int = 0
    max_cores: int = 0
    max_memory_mb: int = 0
    max_disk_gb: int = 0


class GpuDevice(BaseModel):
    id: str
    node: str
    # PCI address as Proxmox wants it, e.g. "0000:01:00" (all functions).
    pci: str = ""
    model: str = "GPU"


class GpuConfig(BaseModel):
    # Name of a Proxmox PCI resource mapping (Datacenter > Resource Mappings).
    # Recommended: lets an API token attach devices; raw PCI ids need root@pam.
    mapping: str = ""
    hostpci_opts: str = "pcie=1"
    max_reservation_hours: int = 72
    max_advance_days: int = 30
    shutdown_timeout_seconds: int = 120
    devices: list[GpuDevice] = []

    @model_validator(mode="after")
    def _check(self):
        ids = [d.id for d in self.devices]
        if len(ids) != len(set(ids)):
            raise ValueError("gpu device ids must be unique")
        if not self.mapping and any(not d.pci for d in self.devices):
            raise ValueError("each gpu device needs a pci address unless gpu.mapping is set")
        return self


class ClusterConfig(BaseModel):
    id: str
    name: str
    kind: Literal["research", "homelab"] = "homelab"
    description: str = ""
    driver: Literal["proxmox", "mock"] = "proxmox"
    endpoint: str = ""
    # API token auth (preferred): token_id "user@realm!name" + token_secret.
    token_id: str = ""
    token_secret: str = ""
    # Or ticket auth, needed for raw (unmapped) PCI passthrough as root@pam.
    username: str = ""
    password: str = ""
    verify_tls: bool = True
    mock_state_file: str = ""

    # Who may use this cluster (Authentik group names). Empty = any signed-in user.
    allowed_groups: list[str] = []
    # required: an admin approves each VM request. none: self-service within quota.
    approval: Literal["required", "none"] = "required"

    storage: str = "local-lvm"
    # True when VM disks live on shared storage (e.g. Ceph): new VMs are spread
    # across nodes and can be moved to whichever node has a free GPU.
    shared_storage: bool = False
    bridge: str = ""
    vlan: int | None = None
    vmid_range: tuple[int, int] = (1000, 1999)
    # Proxmox storage id of the Proxmox Backup Server datastore. Empty = no backups.
    backup_storage: str = ""

    limits: Limits = Limits()
    quota: Quota = Quota()
    templates: list[Template] = []
    gpu: GpuConfig = GpuConfig()

    @model_validator(mode="after")
    def _check(self):
        if self.driver == "proxmox":
            if not self.endpoint:
                raise ValueError(f"cluster {self.id}: endpoint required")
            if not ((self.token_id and self.token_secret) or (self.username and self.password)):
                raise ValueError(f"cluster {self.id}: token_id/token_secret or username/password required")
        return self

    def template(self, template_id: str) -> Template | None:
        return next((t for t in self.templates if t.id == template_id), None)

    def gpu_device(self, gpu_id: str) -> GpuDevice | None:
        return next((d for d in self.gpu.devices if d.id == gpu_id), None)

    @property
    def has_gpus(self) -> bool:
        return bool(self.gpu.devices)


class Config(BaseModel):
    app: AppConfig
    auth: AuthConfig
    clusters: list[ClusterConfig] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check(self):
        ids = [c.id for c in self.clusters]
        if len(ids) != len(set(ids)):
            raise ValueError("cluster ids must be unique")
        return self

    def cluster(self, cluster_id: str) -> ClusterConfig | None:
        return next((c for c in self.clusters if c.id == cluster_id), None)


def load_config(path: str) -> Config:
    with open(path) as fh:
        raw = yaml.safe_load(fh) or {}
    return Config.model_validate(_expand(raw))


@lru_cache
def get_config() -> Config:
    return load_config(os.environ.get("MACS_CONFIG", "config.yaml"))
