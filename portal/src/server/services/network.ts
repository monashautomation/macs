import type { Service } from "@prisma/client";
import { db } from "@/lib/db";
import type { ClusterConfig } from "@/server/config";
import type { Core, Log } from "@/server/core";
import { type FirewallRule, type Params, ProxmoxError } from "@/server/proxmox/types";
import { locate } from "./vms";

/**
 * Network policy: per-VM Proxmox firewall for isolated clusters.
 *
 * On a cluster with `network.isolate`, every portal VM gets its firewall turned
 * on with inbound traffic dropped by default. That is what keeps tenants apart:
 * a VM can talk out, but nothing (including its neighbours) can talk in except
 *   - the owner's access ports (SSH/RDP) from `access_sources`, and
 *   - ports the owner has published as services, from `public_sources`.
 *
 * The portal owns the rules whose comment starts with "macs:" and rewrites them
 * as a set; rules an admin adds by hand in Proxmox are left untouched.
 */
export const MARK = "macs:";

export function desiredRules(
  cluster: ClusterConfig,
  services: Pick<Service, "id" | "name" | "port" | "protocol" | "status">[],
): FirewallRule[] {
  const net = cluster.network;
  const from = (sources: string[]): FirewallRule => (sources.length ? { source: sources.join(",") } : {});
  const access = from(net.access_sources);
  const pub = from(net.public_sources);
  return [
    { type: "in", action: "ACCEPT", proto: "icmp", ...access, comment: `${MARK}access ping` },
    ...net.access_ports.map((port) => ({
      type: "in",
      action: "ACCEPT",
      proto: "tcp",
      dport: String(port),
      ...access,
      comment: `${MARK}access`,
    })),
    ...services
      .filter((s) => s.status === "published")
      .map((s) => ({
        type: "in",
        action: "ACCEPT",
        proto: s.protocol,
        dport: String(s.port),
        ...pub,
        comment: `${MARK}service ${s.id} ${s.name}`,
      })),
  ];
}

/** Bring a VM's firewall in line with policy. Resolves false if the cluster is not isolated. */
export async function applyNetworkPolicy(core: Core, vmId: string, log?: Log): Promise<boolean> {
  const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId }, include: { services: true } });
  const cluster = core.cluster(vm.clusterId);
  if (!cluster.network.isolate) return false;
  const live = await locate(core, vm);
  if (!live || vm.vmid === null) throw new ProxmoxError(`VM ${vm.vmid} not found on the cluster`);
  const drv = core.driver(cluster.id);
  const { node } = live;
  const vmid = vm.vmid;

  // The firewall only filters NICs that opt in.
  const config = await drv.vmConfig(node, vmid);
  const fix: Params = {};
  for (const [k, v] of Object.entries(config)) {
    if (/^net\d+$/.test(k) && !String(v).split(",").includes("firewall=1")) fix[k] = `${v},firewall=1`;
  }
  if (Object.keys(fix).length) await drv.setConfig(node, vmid, fix);

  // Add the new allow rules before removing the old ones, and only then make
  // sure the default is DROP, so a running VM's owner is never locked out.
  const want = desiredRules(cluster, vm.services);
  for (const rule of [...want].reverse()) await drv.firewallAddRule(node, vmid, rule); // each insert goes to the top
  const stale = (await drv.firewallRules(node, vmid))
    .filter((r) => (r.pos ?? 0) >= want.length && String(r.comment ?? "").startsWith(MARK))
    .sort((a, b) => (b.pos ?? 0) - (a.pos ?? 0)); // bottom up so positions stay valid
  for (const rule of stale) await drv.firewallDeleteRule(node, vmid, rule.pos as number);
  await drv.firewallSetOptions(node, vmid, {
    enable: 1,
    policy_in: "DROP",
    policy_out: "ACCEPT",
    dhcp: 1,
    macfilter: 1,
  });
  log?.(`firewall: isolated, ${want.length} allow rules`);
  return true;
}
