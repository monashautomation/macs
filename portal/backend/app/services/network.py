"""Network policy: per-VM Proxmox firewall for isolated clusters.

On a cluster with `network.isolate`, every portal VM gets its firewall turned
on with inbound traffic dropped by default. That is what keeps tenants apart:
a VM can talk out, but nothing (including its neighbours) can talk in except
  - the owner's access ports (SSH/RDP) from `access_sources`, and
  - ports the owner has published as services, from `public_sources`.

The portal owns the rules whose comment starts with "macs:" and rewrites them
as a set; rules an admin adds by hand in Proxmox are left untouched.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select

from ..config import ClusterConfig
from ..core import Core, Log
from ..db import VM, Service
from ..proxmox.base import ProxmoxError
from .vms import locate

MARK = "macs:"


def desired_rules(cluster: ClusterConfig, services: list[Service]) -> list[dict[str, Any]]:
    net = cluster.network
    access = ",".join(net.access_sources) or None
    public = ",".join(net.public_sources) or None
    rules: list[dict[str, Any]] = [
        {"type": "in", "action": "ACCEPT", "proto": "icmp", "source": access, "comment": f"{MARK}access ping"}]
    rules += [{"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": str(port), "source": access,
               "comment": f"{MARK}access"} for port in net.access_ports]
    rules += [{"type": "in", "action": "ACCEPT", "proto": s.protocol, "dport": str(s.port), "source": public,
               "comment": f"{MARK}service {s.id} {s.name}"} for s in services if s.status == "published"]
    return [{k: v for k, v in r.items() if v is not None} for r in rules]


async def apply(core: Core, vm_id: int, log: Log | None = None) -> bool:
    """Bring a VM's firewall in line with policy. Returns False if the cluster is not isolated."""
    with core.Session() as db:
        vm = db.get(VM, vm_id)
        services = list(db.scalars(select(Service).where(Service.vm_id == vm_id)))
    cluster = core.cluster(vm.cluster_id)
    if not cluster.network.isolate:
        return False
    live = await locate(core, vm)
    if not live:
        raise ProxmoxError(f"VM {vm.vmid} not found on the cluster")
    drv, node, vmid = core.driver(cluster.id), live["node"], vm.vmid
    say = log or (lambda _msg: None)

    # The firewall only filters NICs that opt in.
    config = await drv.vm_config(node, vmid)
    nics = {k: str(v) for k, v in config.items() if k.startswith("net") and k[3:].isdigit()}
    fix = {k: f"{v},firewall=1" for k, v in nics.items() if "firewall=1" not in v.split(",")}
    if fix:
        await drv.set_config(node, vmid, **fix)

    # Add the new allow rules before removing the old ones, and only then make
    # sure the default is DROP, so a running VM's owner is never locked out.
    want = desired_rules(cluster, services)
    for rule in reversed(want):  # each insert goes to the top
        await drv.firewall_add_rule(node, vmid, **rule)
    stale = [r for r in await drv.firewall_rules(node, vmid)
             if r["pos"] >= len(want) and str(r.get("comment", "")).startswith(MARK)]
    for rule in sorted(stale, key=lambda r: -r["pos"]):  # bottom up so positions stay valid
        await drv.firewall_delete_rule(node, vmid, rule["pos"])
    await drv.firewall_set_options(node, vmid, enable=1, policy_in="DROP", policy_out="ACCEPT", dhcp=1, macfilter=1)
    say(f"firewall: isolated, {len(want)} allow rules")
    return True
