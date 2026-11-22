"""Driver interface shared by the real Proxmox client and the mock."""
from __future__ import annotations

import re
from abc import ABC, abstractmethod
from typing import Any

HOSTPCI_KEY = re.compile(r"^hostpci\d+$")
DISK_KEYS = ("scsi0", "virtio0", "sata0", "ide0")


class ProxmoxError(Exception):
    pass


class ConsoleStream(ABC):
    """A live VNC (RFB) byte stream to a VM's display, as served by Proxmox."""

    #: VNC password the viewer must present (Proxmox's one-time ticket).
    password: str = ""

    @abstractmethod
    async def recv(self) -> bytes | None:
        """Next chunk from the VM, or None once the stream has closed."""

    @abstractmethod
    async def send(self, data: bytes) -> None: ...

    @abstractmethod
    async def close(self) -> None: ...


class ProxmoxDriver(ABC):
    """All mutating calls block until the Proxmox task has finished and raise
    ProxmoxError if it failed."""

    @abstractmethod
    async def nodes(self) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def vms(self) -> list[dict[str, Any]]:
        """Every QEMU guest in the cluster: vmid, name, node, status, template, plus usage."""

    @abstractmethod
    async def vm_config(self, node: str, vmid: int) -> dict[str, Any]: ...

    @abstractmethod
    async def set_config(self, node: str, vmid: int, **params: Any) -> None: ...

    @abstractmethod
    async def clone(self, node: str, template_vmid: int, newid: int, name: str,
                    storage: str, target: str | None = None) -> None: ...

    @abstractmethod
    async def resize_disk(self, node: str, vmid: int, disk: str, size_gb: int) -> None: ...

    @abstractmethod
    async def start(self, node: str, vmid: int) -> None: ...

    @abstractmethod
    async def shutdown(self, node: str, vmid: int, timeout: int = 120) -> None:
        """Graceful shutdown, forced stop after timeout."""

    @abstractmethod
    async def stop(self, node: str, vmid: int) -> None: ...

    @abstractmethod
    async def reboot(self, node: str, vmid: int) -> None: ...

    @abstractmethod
    async def migrate(self, node: str, vmid: int, target: str) -> None: ...

    @abstractmethod
    async def delete(self, node: str, vmid: int) -> None: ...

    @abstractmethod
    async def vm_ips(self, node: str, vmid: int) -> list[str]: ...

    @abstractmethod
    async def backup(self, node: str, vmid: int, storage: str, notes: str = "",
                     mode: str = "snapshot") -> dict[str, Any]:
        """Run a backup and return the new entry {volid, ctime, size}."""

    @abstractmethod
    async def backups(self, node: str, storage: str, vmid: int) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def restore(self, node: str, vmid: int, volid: str, storage: str, force: bool = False) -> None: ...

    @abstractmethod
    async def create_vm(self, node: str, vmid: int, **params: Any) -> None:
        """Create an empty VM (used for ISO installs)."""

    @abstractmethod
    async def storage_content(self, node: str, storage: str, content: str) -> list[dict[str, Any]]:
        """Volumes of a content type ("iso", ...) on a storage: [{volid, size}]."""

    # Per-VM firewall. Rules are dicts with Proxmox's field names (type, action,
    # proto, dport, source, comment, ...) plus "pos" when read back.

    @abstractmethod
    async def firewall_set_options(self, node: str, vmid: int, **options: Any) -> None: ...

    @abstractmethod
    async def firewall_rules(self, node: str, vmid: int) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def firewall_add_rule(self, node: str, vmid: int, **rule: Any) -> None:
        """Insert a rule at the top (position 0)."""

    @abstractmethod
    async def firewall_delete_rule(self, node: str, vmid: int, pos: int) -> None: ...

    @abstractmethod
    async def cluster_firewall_enabled(self) -> bool:
        """VM firewalls only take effect when the datacenter firewall is on."""

    @abstractmethod
    async def open_console(self, node: str, vmid: int) -> ConsoleStream:
        """Open the VM's graphical console. The caller must close() it."""

    async def close(self) -> None:
        return None

    # -- helpers built on the primitives ---------------------------------

    async def find_vm(self, vmid: int) -> dict[str, Any] | None:
        return next((v for v in await self.vms() if v["vmid"] == vmid), None)


def hostpci_entries(config: dict[str, Any]) -> dict[str, str]:
    return {k: str(v) for k, v in config.items() if HOSTPCI_KEY.match(k)}


def free_hostpci_key(config: dict[str, Any]) -> str:
    for i in range(16):
        if f"hostpci{i}" not in config:
            return f"hostpci{i}"
    raise ProxmoxError("no free hostpci slot")


def disk_key(config: dict[str, Any]) -> str | None:
    return next((k for k in DISK_KEYS if k in config and "media=cdrom" not in str(config[k])), None)


def disk_size_gb(value: str) -> float:
    m = re.search(r"size=(\d+(?:\.\d+)?)([KMGT])", value)
    if not m:
        return 0
    return float(m.group(1)) * {"K": 1 / 1024 / 1024, "M": 1 / 1024, "G": 1, "T": 1024}[m.group(2)]
