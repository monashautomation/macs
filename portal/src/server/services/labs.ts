import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Vm } from "@prisma/client";
import { env } from "@/env";
import { db } from "@/lib/db";
import type { Core, Log } from "@/server/core";
import { applyNetworkPolicy } from "./network";
import { notify } from "./notify";
import { installSetup } from "./setups";
import { locate, provision } from "./vms";

/**
 * Labs: a few VMs deployed together from a blueprint. On an isolated cluster
 * the members are allowed to reach each other (and nobody else's VMs), know
 * each other by name, and share a secret their setups can use to join up.
 */
export interface Blueprint {
  id: string;
  name: string;
  description: string;
  members: { role: string; setupSlug?: string; cores: number; memoryMb: number; diskGb: number }[];
  /** First steps shown on the lab's VMs. {name} is the lab's name. */
  steps: string[];
}

const small = { cores: 1, memoryMb: 1024, diskGb: 10 };
const medium = { cores: 2, memoryMb: 2048, diskGb: 20 };

export const BLUEPRINTS: Blueprint[] = [
  {
    id: "pair",
    name: "Two servers",
    description:
      "Two plain Linux servers that can reach each other by name. Practise SSH between machines, Ansible, or running a client against a server.",
    members: [
      { role: "a", ...small },
      { role: "b", ...small },
    ],
    steps: ["Sign in to {name}-a", "From it, run: ping {name}-b", "Copy an SSH key across with ssh-copy-id"],
  },
  {
    id: "web-db",
    name: "Web server and database",
    description:
      "A Docker host for your app and a separate PostgreSQL server it can reach, the way real deployments are split.",
    members: [
      { role: "web", setupSlug: "docker", ...medium },
      { role: "db", setupSlug: "lab-postgres", ...medium },
    ],
    steps: [
      "On either machine, read the database password: sudo cat /root/lab-secret",
      "From {name}-web, connect: docker run -it --rm postgres psql -h {name}-db -U postgres",
      "Run your app on {name}-web and publish its port",
    ],
  },
  {
    id: "k3s-cluster",
    name: "Kubernetes cluster",
    description: "A three-node k3s cluster: one server and two agents, already joined.",
    members: [
      { role: "server", setupSlug: "lab-k3s-server", ...medium },
      { role: "agent-1", setupSlug: "lab-k3s-agent", ...medium },
      { role: "agent-2", setupSlug: "lab-k3s-agent", ...medium },
    ],
    steps: [
      "Sign in to {name}-server",
      "See all three nodes: sudo kubectl get nodes",
      "Deploy something: sudo kubectl create deployment web --image=nginx --replicas=3",
    ],
  },
];

export function blueprintOut(b: Blueprint) {
  const sum = (k: "cores" | "memoryMb" | "diskGb") => b.members.reduce((n, m) => n + m[k], 0);
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    members: b.members.map((m) => ({ role: m.role, cores: m.cores, memoryMb: m.memoryMb, diskGb: m.diskGb })),
    cores: sum("cores"),
    memoryMb: sum("memoryMb"),
    diskGb: sum("diskGb"),
  };
}

/**
 * The lab's shared secret (a database password, a cluster join token). Derived
 * rather than stored, so it is in no table and a rebuilt member gets the same one.
 */
export function labSecret(labId: string): string {
  return createHmac("sha256", env().BETTER_AUTH_SECRET)
    .update(`macs-lab:${labId}`)
    .digest("hex")
    .slice(0, 32);
}

async function firstIp(core: Core, vm: Pick<Vm, "clusterId" | "vmid">): Promise<string | null> {
  const live = await locate(core, vm);
  if (!live || vm.vmid === null || live.status !== "running") return null;
  try {
    const ips = (await core.driver(vm.clusterId).vmIps(live.node, vm.vmid)).filter((ip) => isIP(ip));
    return ips.find((ip) => isIP(ip) === 4) ?? ips[0] ?? null;
  } catch {
    return null;
  }
}

/** Addresses of a lab's running members (all of them, or all but one). */
export async function labAddresses(core: Core, labId: string, exceptVmId?: string) {
  const members = await db.vm.findMany({
    where: {
      labId,
      status: "active",
      vmid: { not: null },
      ...(exceptVmId ? { id: { not: exceptVmId } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  const out: { name: string; role: string; ip: string }[] = [];
  for (const m of members) {
    const ip = await firstIp(core, m);
    if (ip) out.push({ name: m.name, role: m.labRole, ip });
  }
  return out;
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * Shell that tells a lab member about its lab: LAB_* variables for setup
 * scripts, the other members in /etc/hosts, and the secret in /root/lab-secret.
 */
export async function labScript(core: Core, vm: Pick<Vm, "labId">): Promise<string> {
  if (!vm.labId) return "";
  const lab = await db.lab.findUniqueOrThrow({ where: { id: vm.labId } });
  const peers = await labAddresses(core, lab.id);
  const lines = [
    `export LAB_NAME=${shq(lab.name)}`,
    `export LAB_SECRET=${shq(labSecret(lab.id))}`,
    `export LAB_PEERS=${shq(peers.map((p) => `${p.name}=${p.ip}`).join(" "))}`,
    ...peers.map((p) => `export LAB_${p.role.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_IP=${shq(p.ip)}`),
    '( umask 077; printf "%s\\n" "$LAB_SECRET" > /root/lab-secret )',
    "sed -i '/# macs-lab$/d' /etc/hosts",
    ...peers.map((p) => `echo ${shq(`${p.ip} ${p.name} # macs-lab`)} >> /etc/hosts`),
  ];
  return lines.join("\n");
}

/** Open the firewall between a member and its lab, and tell the guest who its peers are. */
async function linkMember(core: Core, vm: Vm, log: Log) {
  await applyNetworkPolicy(core, vm.id, log);
  const live = await locate(core, vm);
  if (!live || vm.vmid === null) return;
  const result = await core
    .driver(vm.clusterId)
    .runInGuest(live.node, vm.vmid, `set -eu\n${await labScript(core, vm)}`, { timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`could not write the lab's host names: ${result.output.trim()}`);
  log("lab: peers added to /etc/hosts");
}

/** Members' addresses changed (one was rebuilt or removed): refresh every firewall. */
export async function relinkLab(core: Core, labId: string, log?: Log) {
  const members = await db.vm.findMany({ where: { labId, status: "active", vmid: { not: null } } });
  for (const m of members) {
    try {
      await applyNetworkPolicy(core, m.id);
    } catch (e) {
      log?.(`could not refresh ${m.name}'s firewall: ${(e as Error).message}`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bring a lab up: create every member, wait until they have addresses, then
 * wire them together and install their setups in blueprint order (so a
 * cluster's agents find its server already running).
 */
export async function deployLab(
  core: Core,
  labId: string,
  jobs: { vmId: string; jobId: string }[],
  opts: { ipWaitMs?: number } = {},
) {
  const lab = await db.lab.findUniqueOrThrow({ where: { id: labId } });
  let failed = 0;
  for (const { vmId, jobId } of jobs) {
    if (!(await core.runJob(jobId, (log) => provision(core, vmId, log, { setup: false })))) failed++;
  }
  if (!failed) {
    const deadline = Date.now() + (opts.ipWaitMs ?? 5 * 60_000);
    for (;;) {
      const have = await labAddresses(core, labId);
      if (have.length >= jobs.length || Date.now() > deadline) break;
      await sleep(3000);
    }
    for (const { vmId } of jobs) {
      const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId } });
      if (vm.status !== "active") continue;
      const jobId = await core.tryJob("lab-setup", vm);
      const ok =
        jobId &&
        (await core.runJob(jobId, async (log) => {
          await linkMember(core, vm, log);
          if (vm.setupSlug) await installSetup(core, vm.id, log);
        }));
      if (!ok) failed++;
    }
  }
  await notify(lab.ownerId, {
    kind: failed ? "lab.failed" : "lab.ready",
    title: failed ? `Lab ${lab.name} did not finish setting up` : `Lab ${lab.name} is ready`,
    body: failed ? "Open its VMs to see what went wrong; a failed setup can be retried." : "",
    link: "/",
  });
}
