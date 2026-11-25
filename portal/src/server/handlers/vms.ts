import type { Setup } from "@prisma/client";
import { z } from "zod";
import { env } from "@/env";
import { db } from "@/lib/db";
import { toPublicUser } from "@/lib/public-user";
import { canUse, hasGpus } from "@/server/config";
import { core, type Log } from "@/server/core";
import { HttpError, isAdmin, type Who } from "@/server/http";
import { ProxmoxError, type Timeframe } from "@/server/proxmox/types";
import { archiveVm, backupVm, restoreVm } from "@/server/services/backups";
import { getImage, imageOut } from "@/server/services/images";
import { BLUEPRINTS, blueprintOut } from "@/server/services/labs";
import { applyNetworkPolicy } from "@/server/services/network";
import { bookingError } from "@/server/services/schedule";
import { defaultImage, generatePassword, installSetup, setupOut } from "@/server/services/setups";
import {
  destroyVm,
  locate,
  type PowerAction,
  power,
  provision,
  quotaError,
  usage,
  VM_LIVE,
} from "@/server/services/vms";
import {
  busyVmIds,
  connections,
  jobOut,
  liveView,
  liveViews,
  reservationOut,
  serviceOut,
  vmOut,
} from "@/server/views";

export const NAME = /^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const SSH_KEY = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-\S+) [A-Za-z0-9+/=]+( .*)?$/;
const withPeople = { owner: true, reviewedBy: true } as const;

/**
 * The VM if the caller may act on it; 404 otherwise so ids cannot be probed.
 *
 * "own" (the default): its owner, or an admin. "use": also people the owner
 * shared it with, who may look at it, power it and open its console, and
 * nothing else. Every handler that changes the VM itself asks for "own".
 */
export async function getVm(who: Who, id: string, need: "own" | "use" = "own") {
  const mine = { id, ownerId: who.id };
  const vm = await db.vm.findFirst({
    where: isAdmin(who)
      ? { id }
      : need === "use"
        ? { OR: [mine, { id, shares: { some: { userId: who.id } } }] }
        : mine,
    include: withPeople,
  });
  if (!vm) throw new HttpError(404, "VM not found");
  return vm;
}

/** How the caller relates to a VM they can see. */
export const accessOf = (who: Who, vm: { ownerId: string }): "owner" | "admin" | "shared" =>
  vm.ownerId === who.id ? "owner" : isAdmin(who) ? "admin" : "shared";

/** Register and launch a background job for a VM; resolves to the job id. */
export async function startJob(
  kind: string,
  vm: { id: string; name: string; clusterId: string },
  who: Who | null,
  fn: (log: Log) => Promise<void>,
): Promise<string> {
  const c = core();
  const jobId = await c.createJob(kind, vm, who?.id ?? null); // Busy -> 409
  await c.audit(who?.id ?? null, kind, `${vm.clusterId}/${vm.name}`);
  c.spawnJob(jobId, fn);
  return jobId;
}

// -- session and clusters ------------------------------------------------

export async function session(who: Who) {
  const e = env();
  const profile = await db.profile.findUnique({ where: { userId: who.id } });
  const app = new URL(e.APP_URL);
  return {
    id: who.id,
    name: who.name,
    email: who.email,
    isAdmin: isAdmin(who),
    sshPublicKey: profile?.sshPublicKey ?? "",
    unread: await db.notification.count({ where: { userId: who.id, readAt: null } }),
    consoleWsUrl:
      e.CONSOLE_WS_URL ||
      `${app.protocol === "https:" ? "wss" : "ws"}://${app.hostname}:${e.CONSOLE_WS_PORT}/console-ws`,
  };
}

export async function listClusters(who: Who) {
  const c = core();
  const out = [];
  const setups = await db.setup.findMany({
    where: { enabled: true, listed: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  for (const cl of c.cfg.clusters) {
    if (!canUse(cl, who)) continue;
    let nodes: Awaited<ReturnType<ReturnType<typeof c.driver>["nodes"]>> = [];
    let error: string | null = null;
    try {
      nodes = await c.cached(cl.id, "nodes", () => c.driver(cl.id).nodes(), 15_000);
    } catch (e) {
      if (!(e instanceof ProxmoxError)) throw e;
      error = e.message;
    }
    const images = await db.image.findMany({
      where: { clusterId: cl.id, enabled: true },
      orderBy: [{ gpuReady: "desc" }, { kind: "desc" }, { name: "asc" }],
    });
    out.push({
      id: cl.id,
      name: cl.name,
      kind: cl.kind,
      description: cl.description,
      approval: cl.approval,
      hasGpus: hasGpus(cl),
      gpuCount: cl.gpu.devices.length,
      hasBackups: !!cl.backup_storage,
      limits: {
        maxCores: cl.limits.max_cores,
        maxMemoryMb: cl.limits.max_memory_mb,
        maxDiskGb: cl.limits.max_disk_gb,
      },
      quota: {
        maxVms: cl.quota.max_vms,
        maxCores: cl.quota.max_cores,
        maxMemoryMb: cl.quota.max_memory_mb,
        maxDiskGb: cl.quota.max_disk_gb,
      },
      usage: await usage(who.id, cl.id),
      gpuRules: {
        maxReservationHours: cl.gpu.max_reservation_hours,
        maxAdvanceDays: cl.gpu.max_advance_days,
      },
      images: images.map(imageOut),
      setups: cl.setups ? setups.map(setupOut) : [],
      labs: cl.labs && cl.approval === "none" ? BLUEPRINTS.map(blueprintOut) : [],
      lifetimeDays: cl.lifetime_days,
      maxSnapshots: cl.max_snapshots,
      defaultImage: defaultImage(cl, images)?.slug ?? null,
      network: {
        label: cl.network.label,
        description: cl.network.description,
        isolated: cl.network.isolate,
        services: cl.network.services,
        serviceApproval: cl.network.service_approval,
        maxServicesPerVm: cl.network.max_services_per_vm,
      },
      nodes,
      error,
    });
  }
  return out;
}

// -- VMs -----------------------------------------------------------------

export async function listVms(who: Who, scope: "mine" | "all") {
  if (scope === "all" && !isAdmin(who)) throw new HttpError(403, "Forbidden");
  const rows = await db.vm.findMany({
    where: {
      status: { not: "deleted" },
      ...(scope === "mine" ? { OR: [{ ownerId: who.id }, { shares: { some: { userId: who.id } } }] } : {}),
    },
    include: withPeople,
    orderBy: { createdAt: "desc" },
  });
  const [lives, busy] = await Promise.all([
    liveViews(
      core(),
      rows.map((v) => v.clusterId),
    ),
    busyVmIds(rows.map((v) => v.id)),
  ]);
  return rows.map((v) => ({
    ...vmOut(v, lives.get(v.clusterId)!, busy.has(v.id)),
    access: accessOf(who, v),
  }));
}

export const VmCreate = z.object({
  clusterId: z.string(),
  name: z.string().trim().toLowerCase(),
  imageSlug: z.string(),
  cores: z.number().int().min(1),
  memoryMb: z.number().int().min(512),
  diskGb: z.number().int().min(8),
  sshPublicKey: z.string().max(8000).default(""),
  wantsGpu: z.boolean().default(false),
  justification: z.string().trim().max(2000).default(""),
  /** Install this ready-made setup once the VM is up. */
  setupSlug: z.string().default(""),
  /** Publish the setup's ports as public services when it is installed. */
  publishPorts: z.boolean().default(false),
  /** Also set a generated console password (returned once). Self-service clusters only. */
  autoLogin: z.boolean().default(false),
});

export async function createVm(who: Who, input: z.input<typeof VmCreate>) {
  const body = VmCreate.parse(input);
  const c = core();
  const cluster = c.findCluster(body.clusterId);
  if (!cluster || !canUse(cluster, who)) throw new HttpError(404, "cluster not found");
  const image = await getImage(cluster.id, body.imageSlug);
  if (!image?.enabled) throw new HttpError(422, "that image is not in the library");
  if (!NAME.test(body.name)) {
    throw new HttpError(
      422,
      "name must be a hostname: lowercase letters, digits and dashes, up to 40 characters",
    );
  }
  let key = body.sshPublicKey.trim();
  if (image.kind === "iso") {
    key = ""; // nothing to inject a key into; the user runs the installer
  } else if (image.os === "linux") {
    if (!key && !body.autoLogin) throw new HttpError(422, "an SSH public key is required for Linux VMs");
    if (key.split("\n").some((line) => line.trim() && !SSH_KEY.test(line.trim()))) {
      throw new HttpError(422, "that does not look like an SSH public key");
    }
  }
  const lim = cluster.limits;
  if (body.cores > lim.max_cores || body.memoryMb > lim.max_memory_mb || body.diskGb > lim.max_disk_gb) {
    throw new HttpError(
      422,
      `over the per-VM limit (${lim.max_cores} cores, ${lim.max_memory_mb} MB, ${lim.max_disk_gb} GB)`,
    );
  }
  const wantsGpu = body.wantsGpu && hasGpus(cluster);
  if (cluster.approval === "required" && !body.justification) {
    throw new HttpError(422, "tell the approvers what the VM is for");
  }
  if (await db.vm.findFirst({ where: { clusterId: cluster.id, name: body.name, status: { in: VM_LIVE } } })) {
    throw new HttpError(409, `a VM named ${body.name} already exists on ${cluster.name}`);
  }
  const over = quotaError(cluster, await usage(who.id, cluster.id), body);
  if (over) throw new HttpError(422, over);

  const selfService = cluster.approval === "none";
  let setup: Setup | null = null;
  if (body.setupSlug) {
    setup = cluster.setups
      ? await db.setup.findFirst({ where: { slug: body.setupSlug, enabled: true, listed: true } })
      : null;
    if (!setup) throw new HttpError(422, "that setup is not available on this cluster");
    if (image.kind !== "template" || image.os !== "linux") {
      throw new HttpError(422, "setups install on a prepared Linux image, not an installer or Windows");
    }
    if (body.cores < setup.cores || body.memoryMb < setup.memoryMb || body.diskGb < setup.diskGb) {
      throw new HttpError(
        422,
        `${setup.name} needs at least ${setup.cores} vCPU, ${setup.memoryMb / 1024} GB memory and ${setup.diskGb} GB disk`,
      );
    }
  }
  // The password exists only in memory until the provisioning job uses it, so
  // it is only offered where provisioning starts straight away.
  const password =
    body.autoLogin && selfService && image.kind === "template" && image.os === "linux"
      ? generatePassword()
      : undefined;
  if (!key && image.kind === "template" && image.os === "linux" && !password) {
    throw new HttpError(422, "an SSH public key is required for Linux VMs");
  }
  const vm = await db.vm.create({
    data: {
      clusterId: cluster.id,
      name: body.name,
      ownerId: who.id,
      imageSlug: image.slug,
      cores: body.cores,
      memoryMb: body.memoryMb,
      diskGb: body.diskGb,
      sshPublicKey: key,
      justification: body.justification,
      status: selfService ? "provisioning" : "pending",
      // GPU access always needs infrastructure, even on self-service clusters.
      gpuAccess: wantsGpu ? "requested" : "none",
      setupSlug: setup?.slug ?? "",
      setupStatus: setup ? "pending" : "none",
    },
    include: withPeople,
  });
  if (key) {
    await db.profile.upsert({
      where: { userId: who.id },
      create: { userId: who.id, sshPublicKey: key },
      update: { sshPublicKey: key },
    });
  }
  c.setIntent(vm.id, { password, publish: body.publishPorts });
  if (selfService) {
    await startJob("provision", vm, who, (log) => provision(c, vm.id, log));
  } else {
    await c.audit(
      who.id,
      "request-vm",
      `${cluster.id}/${vm.name}`,
      `${vm.cores}c/${vm.memoryMb}MB/${vm.diskGb}GB gpu=${wantsGpu}`,
    );
  }
  return {
    ...vmOut(vm, await liveView(c, cluster.id), selfService),
    // Shown to the owner once, now; it is not stored anywhere they can get it back from.
    login: password ? { user: image.defaultUser, password } : null,
  };
}

export const QuickDeploy = z.object({
  clusterId: z.string(),
  setupSlug: z.string().default(""),
  imageSlug: z.string().default(""),
});

/**
 * One click: pick the name, size, image and login for them. Works where VMs
 * are self-service; approval clusters need the request form.
 */
export async function quickDeploy(who: Who, body: z.infer<typeof QuickDeploy>) {
  const c = core();
  const cluster = c.findCluster(body.clusterId);
  if (!cluster || !canUse(cluster, who)) throw new HttpError(404, "cluster not found");
  if (cluster.approval !== "none")
    throw new HttpError(422, `${cluster.name} needs a request; use the New VM form`);
  const images = await db.image.findMany({ where: { clusterId: cluster.id, enabled: true } });
  const setup = body.setupSlug
    ? await db.setup.findFirst({ where: { slug: body.setupSlug, enabled: true, listed: true } })
    : null;
  if (body.setupSlug && (!setup || !cluster.setups))
    throw new HttpError(422, "that setup is not available on this cluster");
  const image = body.imageSlug
    ? images.find((i) => i.slug === body.imageSlug)
    : defaultImage(cluster, images);
  if (!image) throw new HttpError(422, "no suitable image is in the library for this cluster");
  if (image.kind === "iso") throw new HttpError(422, "installers are set up by hand; use the New VM form");

  const lim = cluster.limits;
  const size = { cores: setup?.cores ?? 2, memoryMb: setup?.memoryMb ?? 2048, diskGb: setup?.diskGb ?? 20 };
  if (size.cores > lim.max_cores || size.memoryMb > lim.max_memory_mb || size.diskGb > lim.max_disk_gb) {
    throw new HttpError(422, `${setup?.name ?? image.name} needs more than ${cluster.name} allows per VM`);
  }
  // A readable, unused hostname: "gitea", then "gitea-2", ...
  const base = (setup?.slug ?? image.slug).replace(/[^a-z0-9-]/g, "-").slice(0, 30) || "vm";
  const taken = new Set(
    (
      await db.vm.findMany({
        where: { clusterId: cluster.id, status: { in: VM_LIVE } },
        select: { name: true },
      })
    ).map((v) => v.name),
  );
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  const profile = await db.profile.findUnique({ where: { userId: who.id } });
  return createVm(who, {
    clusterId: cluster.id,
    name,
    imageSlug: image.slug,
    ...size,
    sshPublicKey: image.os === "linux" ? (profile?.sshPublicKey ?? "") : "",
    wantsGpu: false,
    justification: "",
    setupSlug: setup?.slug ?? "",
    publishPorts: !!setup && cluster.network.services,
    autoLogin: true,
  });
}

/** Run a VM's setup again after it failed. */
export async function retrySetup(who: Who, id: string) {
  const c = core();
  const vm = await getVm(who, id);
  if (vm.status !== "active" || !vm.setupSlug || vm.setupStatus !== "failed") {
    throw new HttpError(409, "there is no failed setup to retry on this VM");
  }
  return { jobId: await startJob("setup", vm, who, (log) => installSetup(c, vm.id, log)) };
}

export async function vmDetail(who: Who, id: string) {
  const c = core();
  const vm = await getVm(who, id, "use");
  const cluster = c.findCluster(vm.clusterId);
  const access = accessOf(who, vm);
  const out = vmOut(vm, await liveView(c, vm.clusterId), await c.vmBusy(vm.id));
  const image = await getImage(vm.clusterId, vm.imageSlug);
  const setup = vm.setupSlug ? await db.setup.findUnique({ where: { slug: vm.setupSlug } }) : null;
  let ips: string[] = [];
  if (out.power === "running" && out.node && vm.vmid !== null) {
    const { node } = out;
    const vmid = vm.vmid;
    try {
      ips = await c.cached(
        vm.clusterId,
        `ips:${vmid}`,
        () => c.driver(vm.clusterId).vmIps(node, vmid),
        20_000,
      );
    } catch (e) {
      if (!(e instanceof ProxmoxError)) throw e;
    }
  }
  const lab = vm.labId ? await db.lab.findUnique({ where: { id: vm.labId } }) : null;
  const blueprint = lab ? BLUEPRINTS.find((b) => b.id === lab.blueprint) : undefined;
  const [shares, services, jobs, reservations, backups] = await Promise.all([
    db.vmShare.findMany({ where: { vmId: vm.id }, include: { user: true }, orderBy: { createdAt: "asc" } }),
    db.service.findMany({
      where: { vmId: vm.id },
      include: { vm: { include: { owner: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.job.findMany({
      where: { vmId: vm.id },
      include: { vm: true, user: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    db.reservation.findMany({
      where: { vmId: vm.id, endAt: { gt: new Date(Date.now() - 7 * 86_400_000) } },
      include: { vm: true, user: true },
      orderBy: { startAt: "desc" },
      take: 20,
    }),
    db.backup.findMany({ where: { vmId: vm.id }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    ...out,
    access,
    sharedWith: shares.map((s) => toPublicUser(s.user)),
    lab: lab
      ? {
          id: lab.id,
          name: lab.name,
          blueprint: blueprint?.name ?? lab.blueprint,
          role: vm.labRole,
          steps: (blueprint?.steps ?? []).map((s) => s.replaceAll("{name}", lab.name)),
        }
      : null,
    lifetimeDays: cluster?.lifetime_days ?? 0,
    maxSnapshots: cluster?.max_snapshots ?? 0,
    canResize: cluster?.approval === "none" || isAdmin(who),
    limits: cluster
      ? {
          maxCores: cluster.limits.max_cores,
          maxMemoryMb: cluster.limits.max_memory_mb,
          maxDiskGb: cluster.limits.max_disk_gb,
        }
      : null,
    image: image ? imageOut(image) : null,
    hasSshKey: !!vm.sshPublicKey.trim(),
    setup: setup ? { ...setupOut(setup), status: vm.setupStatus } : null,
    ips,
    connections: out.power === "running" ? connections(cluster, image, vm.name, ips) : [],
    services: services.map((s) => serviceOut(c, s, ips)),
    jobs: jobs.map(jobOut),
    reservations: reservations.map(reservationOut),
    backups: backups.map((b) => ({
      id: b.id,
      notes: b.notes,
      sizeBytes: Number(b.sizeBytes),
      createdAt: b.createdAt.toISOString(),
    })),
  };
}

export const MetricsQuery = z.object({ timeframe: z.enum(["hour", "day", "week"]).default("hour") });

/** CPU, memory and network history for a running VM (empty when it is not running). */
export async function vmMetrics(who: Who, id: string, timeframe: Timeframe) {
  const c = core();
  const vm = await getVm(who, id, "use");
  if (vm.status !== "active" || vm.vmid === null) return { timeframe, points: [] };
  const vmid = vm.vmid;
  const live = (await c.liveVms(vm.clusterId)).get(vmid);
  if (live?.status !== "running") return { timeframe, points: [] };
  const points = await c.cached(
    vm.clusterId,
    `metrics:${vmid}:${timeframe}`,
    () => c.driver(vm.clusterId).vmMetrics(live.node, vmid, timeframe),
    30_000,
  );
  return {
    timeframe,
    points: points.map((p) => ({
      time: p.time * 1000,
      cpu: Math.round(p.cpu * 1000) / 10,
      memGb: Math.round((p.mem / 1024 ** 3) * 100) / 100,
      maxMemGb: Math.round((p.maxmem / 1024 ** 3) * 100) / 100,
      netInKb: Math.round(p.netin / 1024),
      netOutKb: Math.round(p.netout / 1024),
    })),
  };
}

export const Power = z.object({ action: z.enum(["start", "shutdown", "stop", "reboot"]) });

export async function powerVm(who: Who, id: string, action: PowerAction) {
  const vm = await getVm(who, id, "use");
  if (vm.status !== "active") throw new HttpError(409, "the VM is not active");
  if (vm.expired && action !== "shutdown" && action !== "stop")
    throw new HttpError(409, `${vm.name} has expired; extend it to start it again`);
  return { jobId: await startJob(action, vm, who, (log) => power(core(), vm.id, action, log)) };
}

export async function deleteVm(who: Who, id: string) {
  const c = core();
  const vm = await getVm(who, id);
  if (
    ["pending", "rejected", "archived"].includes(vm.status) ||
    (vm.status === "error" && vm.vmid === null)
  ) {
    // Nothing exists on the cluster (archives stay in PBS until pruned).
    await db.service.deleteMany({ where: { vmId: vm.id } });
    await db.vm.update({ where: { id: vm.id }, data: { status: "deleted" } });
    await c.audit(who.id, "delete", `${vm.clusterId}/${vm.name}`);
    return { jobId: null };
  }
  if (vm.status !== "active" && vm.status !== "error") {
    throw new HttpError(409, `cannot delete a VM that is ${vm.status}`);
  }
  return { jobId: await startJob("destroy", vm, who, (log) => destroyVm(c, vm.id, log)) };
}

export const GpuAccessRequest = z.object({
  justification: z.string().trim().min(1, "tell the approvers what the GPU is for").max(2000),
});

export async function requestGpuAccess(who: Who, id: string, body: z.infer<typeof GpuAccessRequest>) {
  const c = core();
  const vm = await getVm(who, id);
  const cluster = c.findCluster(vm.clusterId);
  if (!cluster || !hasGpus(cluster)) throw new HttpError(409, "this cluster has no GPUs");
  if (!["pending", "active"].includes(vm.status) || vm.gpuAccess !== "none") {
    throw new HttpError(409, "GPU access was already requested for this VM");
  }
  await db.vm.update({
    where: { id: vm.id },
    data: {
      gpuAccess: "requested",
      justification: `${vm.justification}\n\nGPU: ${body.justification}`.trim(),
    },
  });
  await c.audit(who.id, "request-gpu-access", `${vm.clusterId}/${vm.name}`, body.justification);
}

/** Open the VM's screen. Returns a one-time token for the console websocket. */
export async function openConsole(who: Who, id: string) {
  const c = core();
  const vm = await getVm(who, id, "use");
  if (vm.status !== "active" || vm.vmid === null) throw new HttpError(409, "the VM is not active");
  const live = await locate(c, vm);
  if (live?.status !== "running") throw new HttpError(409, "start the VM to open its console");
  const stream = await c.driver(vm.clusterId).openConsole(live.node, vm.vmid);
  await c.audit(who.id, "console", `${vm.clusterId}/${vm.name}`);
  return { token: c.holdConsole(who.id, stream), password: stream.password, name: vm.name };
}

// -- backups -------------------------------------------------------------

function backupCluster(clusterId: string) {
  const cluster = core().findCluster(clusterId);
  if (!cluster?.backup_storage) throw new HttpError(409, "backups are not configured for this cluster");
  return cluster;
}

export const BackupCreate = z.object({ notes: z.string().trim().max(200).default("") });

export async function createBackup(who: Who, id: string, body: z.infer<typeof BackupCreate>) {
  const vm = await getVm(who, id);
  backupCluster(vm.clusterId);
  if (vm.status !== "active") throw new HttpError(409, "the VM is not active");
  return { jobId: await startJob("backup", vm, who, (log) => backupVm(core(), vm.id, body.notes, log)) };
}

export async function archive(who: Who, id: string) {
  const vm = await getVm(who, id);
  backupCluster(vm.clusterId);
  if (vm.status !== "active") throw new HttpError(409, "the VM is not active");
  return { jobId: await startJob("archive", vm, who, (log) => archiveVm(core(), vm.id, log)) };
}

export const Restore = z.object({ backupId: z.string() });

export async function restore(who: Who, id: string, body: z.infer<typeof Restore>) {
  const vm = await getVm(who, id);
  const cluster = backupCluster(vm.clusterId);
  if (vm.status !== "active" && vm.status !== "archived") {
    throw new HttpError(409, `cannot restore a VM that is ${vm.status}`);
  }
  // Only backups the portal recorded for this VM: never trust a client-supplied volume id.
  const backup = await db.backup.findFirst({ where: { id: body.backupId, vmId: vm.id } });
  if (!backup) throw new HttpError(404, "backup not found");
  if (vm.status === "archived" && !isAdmin(who)) {
    // Coming back from the archive counts against quota again.
    const over = quotaError(cluster, await usage(vm.ownerId, cluster.id), vm);
    if (over) throw new HttpError(422, over);
  }
  return { jobId: await startJob("restore", vm, who, (log) => restoreVm(core(), vm.id, backup.volid, log)) };
}

// -- published services --------------------------------------------------

export const ServiceCreate = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(500).default(""),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
  scheme: z.enum(["", "http", "https"]).default(""),
});

async function syncFirewall(vmId: string) {
  try {
    await applyNetworkPolicy(core(), vmId);
  } catch (e) {
    if (e instanceof ProxmoxError)
      throw new HttpError(502, `could not update the VM's firewall: ${e.message}`);
    throw e;
  }
}

const serviceWithVm = { vm: { include: { owner: true } } } as const;

/** Everything published on the clusters this user can use. */
export async function serviceDirectory(who: Who) {
  const c = core();
  const allowed = c.cfg.clusters.filter((cl) => cl.network.services && canUse(cl, who)).map((cl) => cl.id);
  const rows = await db.service.findMany({
    where: { status: "published", vm: { status: "active", clusterId: { in: allowed } } },
    include: serviceWithVm,
    orderBy: { name: "asc" },
  });
  return rows.map((s) => serviceOut(c, s));
}

export async function publishService(who: Who, vmId: string, body: z.infer<typeof ServiceCreate>) {
  const c = core();
  const vm = await getVm(who, vmId);
  const net = c.findCluster(vm.clusterId)?.network;
  if (!net?.services) throw new HttpError(409, "this cluster does not offer published services");
  if (vm.status !== "active") throw new HttpError(409, "the VM is not active");
  if (body.scheme && body.protocol !== "tcp") throw new HttpError(422, "web services use TCP");
  if (body.protocol === "tcp" && net.access_ports.includes(body.port)) {
    throw new HttpError(422, `port ${body.port} is your own access port and cannot be published`);
  }
  const existing = await db.service.findMany({ where: { vmId: vm.id, status: { not: "rejected" } } });
  if (existing.some((s) => s.port === body.port && s.protocol === body.protocol)) {
    throw new HttpError(409, `${body.protocol}/${body.port} is already published on this VM`);
  }
  if (existing.length >= net.max_services_per_vm) {
    throw new HttpError(422, `a VM can publish at most ${net.max_services_per_vm} services`);
  }
  const open = net.service_approval === "none" || isAdmin(who);
  const svc = await db.service.create({
    data: { vmId: vm.id, ...body, status: open ? "published" : "pending" },
    include: serviceWithVm,
  });
  if (open) {
    try {
      await syncFirewall(vm.id);
    } catch (e) {
      await db.service.delete({ where: { id: svc.id } }); // never list a port that is not really open
      throw e;
    }
  }
  await c.audit(
    who.id,
    open ? "publish-service" : "request-service",
    `${vm.clusterId}/${vm.name}`,
    `${body.name} ${body.protocol}/${body.port}`,
  );
  return serviceOut(c, svc);
}

export async function removeService(who: Who, serviceId: string) {
  const svc = await db.service.findFirst({
    where: { id: serviceId, ...(isAdmin(who) ? {} : { vm: { ownerId: who.id } }) },
    include: { vm: true },
  });
  if (!svc) throw new HttpError(404, "service not found");
  await db.service.delete({ where: { id: svc.id } });
  await core().audit(
    who.id,
    "unpublish-service",
    `${svc.vm.clusterId}/${svc.vm.name}`,
    `${svc.name} ${svc.protocol}/${svc.port}`,
  );
  if (svc.status === "published" && svc.vm.status === "active") await syncFirewall(svc.vmId);
}

// -- GPU bookings --------------------------------------------------------

export async function listGpus(who: Who) {
  const c = core();
  const out = [];
  for (const cl of c.cfg.clusters) {
    if (!hasGpus(cl) || !canUse(cl, who)) continue;
    const live = await liveView(c, cl.id);
    const managed = await db.vm.findMany({
      where: { clusterId: cl.id, status: "active", vmid: { not: null } },
      include: { owner: true, reservations: { where: { status: "active" }, take: 1 } },
    });
    const byVmid = new Map(managed.map((v) => [v.vmid as number, v]));
    out.push({
      clusterId: cl.id,
      clusterName: cl.name,
      error: live.error,
      devices: live.gpus.map((g) => {
        const vm = g.holder ? byVmid.get(g.holder.vmid) : undefined;
        return {
          id: g.id,
          node: g.node,
          model: g.model,
          holder: g.holder
            ? {
                vmid: g.holder.vmid,
                name: g.holder.name,
                power: g.holder.status,
                vmId: vm?.id ?? null,
                owner: vm ? { id: vm.owner.id, name: vm.owner.name, image: vm.owner.image } : null,
                bookedUntil: vm?.reservations[0]?.endAt.toISOString() ?? null,
              }
            : null,
        };
      }),
    });
  }
  return out;
}

export const ReservationQuery = z.object({
  clusterId: z.string(),
  start: z.coerce.date(),
  end: z.coerce.date(),
});

export async function listReservations(who: Who, q: z.infer<typeof ReservationQuery>) {
  const cluster = core().findCluster(q.clusterId);
  if (!cluster || !canUse(cluster, who)) throw new HttpError(404, "cluster not found");
  const rows = await db.reservation.findMany({
    where: {
      clusterId: cluster.id,
      status: { not: "cancelled" },
      startAt: { lt: q.end },
      endAt: { gt: q.start },
    },
    include: { vm: true, user: true },
    orderBy: { startAt: "asc" },
  });
  return rows.map(reservationOut);
}

export const Booking = z.object({
  vmId: z.string(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  note: z.string().trim().max(200).default(""),
});

export async function createReservation(who: Who, body: z.infer<typeof Booking>) {
  const c = core();
  const vm = await getVm(who, body.vmId);
  const cluster = c.cluster(vm.clusterId);
  const now = new Date();
  const start = body.startAt < now ? now : body.startAt;
  // One at a time, so two people cannot both take the last slot.
  const created = await c.withLock(`booking:${cluster.id}`, async () => {
    const err = await bookingError(cluster, vm, start, body.endAt, now);
    if (err) throw new HttpError(422, err);
    return db.reservation.create({
      data: {
        clusterId: cluster.id,
        vmId: vm.id,
        userId: who.id,
        startAt: start,
        endAt: body.endAt,
        note: body.note,
      },
      include: { vm: true, user: true },
    });
  });
  await c.audit(
    who.id,
    "book-gpu",
    `${cluster.id}/${vm.name}`,
    `${start.toISOString()} - ${body.endAt.toISOString()}`,
  );
  c.kick();
  return reservationOut(created);
}

export async function cancelReservation(who: Who, id: string) {
  const c = core();
  const r = await db.reservation.findFirst({
    where: { id, ...(isAdmin(who) ? {} : { OR: [{ userId: who.id }, { vm: { ownerId: who.id } }] }) },
    include: { vm: true },
  });
  if (!r) throw new HttpError(404, "booking not found");
  if (r.status === "scheduled") {
    await db.reservation.update({ where: { id }, data: { status: "cancelled" } });
  } else if (r.status === "active") {
    // The scheduler releases the GPU on its next pass.
    await db.reservation.update({ where: { id }, data: { endAt: new Date() } });
  } else {
    throw new HttpError(409, `booking is already ${r.status}`);
  }
  await c.audit(who.id, "cancel-booking", `${r.clusterId}/${r.vm.name}`, r.id);
  c.kick();
}

export async function listJobs(who: Who, scope: "mine" | "all", limit: number) {
  const all = scope === "all" && isAdmin(who);
  const rows = await db.job.findMany({
    where: all
      ? {}
      : {
          OR: [
            { userId: who.id },
            { vm: { ownerId: who.id } },
            { vm: { shares: { some: { userId: who.id } } } },
          ],
        },
    include: { vm: true, user: true },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
  });
  return rows.map(jobOut);
}
