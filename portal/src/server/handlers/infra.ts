import { z } from "zod";
import { env } from "@/env";
import { db } from "@/lib/db";
import { dailyGpuHours } from "@/lib/gpu-hours";
import { toPublicUser } from "@/lib/public-user";
import { rolesForGroups } from "@/lib/roles";
import { type ClusterConfig, hasGpus } from "@/server/config";
import { core } from "@/server/core";
import { HttpError, type Who } from "@/server/http";
import { diskKey, diskSizeGb, findVm, ProxmoxError, type Timeframe } from "@/server/proxmox/types";
import { attachGpu, detachGpu, gpuState } from "@/server/services/gpus";
import { adminImageOut, getImage } from "@/server/services/images";
import { applyNetworkPolicy } from "@/server/services/network";
import { provision, VM_LIVE } from "@/server/services/vms";
import { busyVmIds, liveViews, serviceOut, vmOut } from "@/server/views";
import { startJob } from "./vms";

/** Handlers for the infrastructure workspace. Every route that calls these requires the admin role. */

const withPeople = { owner: true, reviewedBy: true } as const;
const serviceWithVm = { vm: { include: { owner: true } } } as const;

function clusterOr404(id: string): ClusterConfig {
  const cluster = core().findCluster(id);
  if (!cluster) throw new HttpError(404, "cluster not found");
  return cluster;
}

// -- approvals -----------------------------------------------------------

export async function approvals() {
  const c = core();
  const vms = await db.vm.findMany({
    where: { OR: [{ status: "pending" }, { status: "active", gpuAccess: "requested" }] },
    include: withPeople,
    orderBy: { createdAt: "asc" },
  });
  const services = await db.service.findMany({
    where: { status: "pending", vm: { status: "active" } },
    include: serviceWithVm,
    orderBy: { createdAt: "asc" },
  });
  const [lives, busy] = await Promise.all([
    liveViews(
      c,
      vms.map((v) => v.clusterId),
    ),
    busyVmIds(vms.map((v) => v.id)),
  ]);
  return {
    vms: vms.map((v) => vmOut(v, lives.get(v.clusterId)!, busy.has(v.id))),
    services: services.map((s) => serviceOut(c, s)),
  };
}

export const Review = z.object({
  approve: z.boolean(),
  grantGpu: z.boolean().default(false),
  note: z.string().trim().max(1000).default(""),
});

/** Decide a pending VM request, or a GPU-access request on an existing VM. */
export async function reviewVm(who: Who, id: string, body: z.infer<typeof Review>) {
  const c = core();
  const vm = await db.vm.findUnique({ where: { id } });
  if (!vm) throw new HttpError(404, "VM not found");
  const target = `${vm.clusterId}/${vm.name}`;
  const reviewed = { reviewNote: body.note, reviewedById: who.id };
  if (vm.status === "pending") {
    if (!body.approve) {
      await db.vm.update({ where: { id }, data: { ...reviewed, status: "rejected", gpuAccess: "none" } });
      await c.audit(who.id, "reject-vm", target, body.note);
      return { jobId: null };
    }
    if (!c.findCluster(vm.clusterId)) throw new HttpError(409, "the cluster is no longer configured");
    const gpuAccess = vm.gpuAccess === "requested" ? (body.grantGpu ? "approved" : "none") : vm.gpuAccess;
    // Only one reviewer wins if two approve at once.
    const { count } = await db.vm.updateMany({
      where: { id, status: "pending" },
      data: { ...reviewed, status: "provisioning", gpuAccess },
    });
    if (!count) throw new HttpError(409, "someone else already reviewed this request");
    await c.audit(who.id, "approve-vm", target, `gpu=${gpuAccess} ${body.note}`.trim());
    return { jobId: await startJob("provision", vm, who, (log) => provision(c, vm.id, log)) };
  }
  if (vm.status === "active" && vm.gpuAccess === "requested") {
    await db.vm.update({
      where: { id },
      data: { ...reviewed, gpuAccess: body.approve ? "approved" : "none" },
    });
    await c.audit(who.id, body.approve ? "approve-gpu-access" : "reject-gpu-access", target, body.note);
    return { jobId: null };
  }
  throw new HttpError(409, "nothing to review on this VM");
}

export const ServiceReview = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(1000).default(""),
});

export async function reviewService(who: Who, id: string, body: z.infer<typeof ServiceReview>) {
  const c = core();
  const svc = await db.service.findFirst({ where: { id, status: "pending" }, include: { vm: true } });
  if (!svc) throw new HttpError(404, "nothing to review");
  await db.service.update({
    where: { id },
    data: { status: body.approve ? "published" : "rejected", reviewNote: body.note },
  });
  if (body.approve) {
    try {
      await applyNetworkPolicy(c, svc.vmId);
    } catch (e) {
      await db.service.update({ where: { id }, data: { status: "pending" } });
      if (e instanceof ProxmoxError)
        throw new HttpError(502, `could not update the VM's firewall: ${e.message}`);
      throw e;
    }
  }
  await c.audit(
    who.id,
    body.approve ? "approve-service" : "reject-service",
    `${svc.vm.clusterId}/${svc.vm.name}`,
    `${svc.name} ${svc.protocol}/${svc.port}`,
  );
}

export async function allServices() {
  const c = core();
  const rows = await db.service.findMany({
    where: { vm: { status: { not: "deleted" } } },
    include: serviceWithVm,
    orderBy: { createdAt: "desc" },
  });
  return rows.map((s) => serviceOut(c, s));
}

/** Re-apply the firewall policy to every portal VM, e.g. after changing allowed sources. */
export async function networkSync(who: Who, clusterId: string) {
  const c = core();
  const cluster = clusterOr404(clusterId);
  if (!cluster.network.isolate) throw new HttpError(409, "this cluster does not use network isolation");
  const vms = await db.vm.findMany({
    where: { clusterId, status: "active" },
    select: { id: true, name: true },
  });
  const jobId = await c.createJob("network-sync", null, who.id);
  await c.audit(who.id, "network-sync", clusterId, `${vms.length} VMs`);
  c.spawnJob(jobId, async (log) => {
    let failed = 0;
    for (const vm of vms) {
      try {
        await applyNetworkPolicy(c, vm.id);
        log(`${vm.name}: ok`);
      } catch (e) {
        if (!(e instanceof ProxmoxError)) throw e;
        failed++;
        log(`${vm.name}: FAILED ${e.message}`);
      }
    }
    if (failed) throw new ProxmoxError(`${failed} of ${vms.length} VMs could not be updated`);
  });
  return { jobId };
}

// -- GPUs ----------------------------------------------------------------

export const GpuAssign = z.object({ vmId: z.string(), gpuId: z.string().optional() });

/** Give a VM a GPU right now, taking it from the current holder if needed. */
export async function assignGpu(who: Who, body: z.infer<typeof GpuAssign>) {
  const c = core();
  const vm = await db.vm.findFirst({ where: { id: body.vmId, status: "active", vmid: { not: null } } });
  if (!vm) throw new HttpError(404, "VM not found or not active");
  const cluster = c.cluster(vm.clusterId);
  if (body.gpuId && !cluster.gpu.devices.some((d) => d.id === body.gpuId))
    throw new HttpError(404, "GPU not found");
  const vmid = vm.vmid as number;
  return {
    jobId: await startJob("gpu-attach", vm, who, async (log) => {
      await attachGpu(c, cluster, vmid, log, { gpuId: body.gpuId });
    }),
  };
}

export const GpuRelease = z.object({
  clusterId: z.string(),
  vmid: z.number().int(),
  restart: z.boolean().default(true),
});

/** Detach the GPU from any VM on the cluster, portal-managed or not. */
export async function releaseGpu(who: Who, body: z.infer<typeof GpuRelease>) {
  const c = core();
  const cluster = clusterOr404(body.clusterId);
  if (!hasGpus(cluster)) throw new HttpError(404, "cluster not found");
  const run = async (log: (m: string) => void) => {
    await detachGpu(c, cluster, body.vmid, log, body.restart);
  };
  const vm = await db.vm.findFirst({ where: { clusterId: cluster.id, vmid: body.vmid, status: "active" } });
  if (vm) return { jobId: await startJob("gpu-release", vm, who, run) };
  const jobId = await c.createJob("gpu-release", null, who.id);
  await c.audit(who.id, "gpu-release", `${cluster.id}/vmid-${body.vmid}`);
  c.spawnJob(jobId, run);
  return { jobId };
}

// -- adoption ------------------------------------------------------------

/** VMs on the cluster that the portal does not track yet. */
export async function unmanaged(clusterId: string) {
  const c = core();
  clusterOr404(clusterId);
  const live = await c.liveVms(clusterId);
  const known = new Set(
    (
      await db.vm.findMany({
        where: { clusterId, status: { not: "deleted" }, vmid: { not: null } },
        select: { vmid: true },
      })
    ).map((v) => v.vmid),
  );
  return [...live.values()]
    .filter((v) => !v.template && !known.has(v.vmid))
    .sort((a, b) => a.vmid - b.vmid)
    .map((v) => ({ vmid: v.vmid, name: v.name, node: v.node, status: v.status }));
}

export const Adopt = z.object({
  clusterId: z.string(),
  vmid: z.number().int(),
  ownerId: z.string(),
  gpuAccess: z.boolean().default(false),
});

/** Bring an existing Proxmox VM under portal management for a user. */
export async function adopt(who: Who, body: z.infer<typeof Adopt>) {
  const c = core();
  const cluster = clusterOr404(body.clusterId);
  const drv = c.driver(cluster.id);
  const live = await findVm(drv, body.vmid);
  if (!live || live.template) throw new HttpError(404, `no VM ${body.vmid} on ${cluster.name}`);
  const config = await drv.vmConfig(live.node, body.vmid);
  const owner = await db.user.findUnique({ where: { id: body.ownerId } });
  if (!owner) throw new HttpError(404, "that person has not signed in to the portal yet");
  if (
    await db.vm.findFirst({ where: { clusterId: cluster.id, vmid: body.vmid, status: { not: "deleted" } } })
  ) {
    throw new HttpError(409, "that VM is already managed");
  }
  const disk = diskKey(config);
  const vm = await db.vm.create({
    data: {
      clusterId: cluster.id,
      vmid: body.vmid,
      name: live.name || `vm-${body.vmid}`,
      ownerId: owner.id,
      cores: Number(config.cores ?? 1) * Number(config.sockets ?? 1),
      memoryMb: Number.parseInt(String(config.memory ?? 0).replace("current=", ""), 10) || 0,
      diskGb: disk ? Math.floor(diskSizeGb(String(config[disk]))) : 0,
      status: "active",
      gpuAccess: body.gpuAccess ? "approved" : "none",
      justification: "adopted",
      reviewedById: who.id,
    },
  });
  await c.audit(who.id, "adopt-vm", `${cluster.id}/${vm.name}`, `vmid=${body.vmid} owner=${owner.id}`);
  // An adopted VM comes under the cluster's network policy like any other.
  await applyNetworkPolicy(c, vm.id);
  c.invalidate(cluster.id);
  return { id: vm.id };
}

// -- image library -------------------------------------------------------

const ImageFields = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2000).default(""),
  os: z.enum(["linux", "windows", "other"]).default("linux"),
  defaultUser: z.string().trim().max(64).default(""),
  cicustom: z.string().trim().max(255).default(""),
  gpuReady: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  connect: z.array(z.enum(["ssh", "rdp", "sunshine"])).default([]),
  enabled: z.boolean().default(true),
});
export const ImageUpdate = ImageFields;
export const ImageCreate = ImageFields.extend({
  clusterId: z.string(),
  kind: z.enum(["template", "iso"]),
  vmid: z.number().int().optional(),
  volid: z.string().default(""),
});

const cleanTags = (tags: string[]) =>
  [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort().slice(0, 8);

/** Templates and ISOs that exist on the cluster right now. */
async function discover(cluster: ClusterConfig) {
  const c = core();
  const drv = c.driver(cluster.id);
  const templates = [...(await c.liveVms(cluster.id)).values()]
    .filter((v) => v.template)
    .sort((a, b) => a.vmid - b.vmid)
    .map((v) => ({ vmid: v.vmid, name: v.name, node: v.node }));
  const isos = new Map<string, { volid: string; size: number }>();
  if (cluster.iso_storage) {
    for (const n of await drv.nodes()) {
      if (n.status !== "online") continue;
      try {
        for (const v of await drv.storageContent(n.node, cluster.iso_storage, "iso"))
          if (!isos.has(v.volid)) isos.set(v.volid, v);
      } catch (e) {
        if (!(e instanceof ProxmoxError)) throw e; // storage not present on this node
      }
    }
  }
  return { templates, isos: [...isos.values()].sort((a, b) => a.volid.localeCompare(b.volid)) };
}

export async function adminImages(clusterId: string) {
  const cluster = clusterOr404(clusterId);
  let found: Awaited<ReturnType<typeof discover>> = { templates: [], isos: [] };
  let error: string | null = null;
  try {
    found = await discover(cluster);
  } catch (e) {
    if (!(e instanceof ProxmoxError)) throw e;
    error = e.message;
  }
  const rows = await db.image.findMany({ where: { clusterId }, orderBy: { name: "asc" } });
  const inUse = new Map(
    (
      await db.vm.groupBy({ by: ["imageSlug"], where: { clusterId, status: { in: VM_LIVE } }, _count: true })
    ).map((g) => [g.imageSlug, g._count]),
  );
  const liveVmids = new Set(found.templates.map((t) => t.vmid));
  const liveIsos = new Set(found.isos.map((i) => i.volid));
  const listedVmids = new Set(rows.filter((i) => i.kind === "template").map((i) => i.vmid));
  const listedIsos = new Set(rows.filter((i) => i.kind === "iso").map((i) => i.volid));
  return {
    images: rows.map((i) => ({
      ...adminImageOut(i),
      vmCount: inUse.get(i.slug) ?? 0,
      // Flag entries whose backing template/ISO has vanished from the cluster.
      missing:
        !error &&
        (i.kind === "template"
          ? !liveVmids.has(i.vmid as number)
          : !!cluster.iso_storage && !liveIsos.has(i.volid)),
    })),
    unlisted: {
      templates: found.templates.filter((t) => !listedVmids.has(t.vmid)),
      isos: found.isos.filter((i) => !listedIsos.has(i.volid)),
    },
    isoStorage: cluster.iso_storage,
    error,
  };
}

export async function addImage(who: Who, body: z.infer<typeof ImageCreate>) {
  const c = core();
  const cluster = clusterOr404(body.clusterId);
  const found = await discover(cluster);
  if (body.kind === "template" && !found.templates.some((t) => t.vmid === body.vmid)) {
    throw new HttpError(422, `VM ${body.vmid} is not a template on ${cluster.name}`);
  }
  if (body.kind === "iso" && !found.isos.some((i) => i.volid === body.volid)) {
    throw new HttpError(422, `that ISO is not on ${cluster.name}'s ISO storage`);
  }
  const base =
    body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "image";
  let slug = base;
  for (let n = 2; await getImage(cluster.id, slug); n++) slug = `${base}-${n}`;
  const { clusterId: _c, kind, vmid, volid, tags, ...fields } = body;
  const image = await db.image.create({
    data: {
      ...fields,
      tags: cleanTags(tags),
      clusterId: cluster.id,
      slug,
      kind,
      vmid: kind === "template" ? (vmid ?? null) : null,
      volid: kind === "iso" ? volid : "",
    },
  });
  await c.audit(who.id, "add-image", `${cluster.id}/${slug}`, body.name);
  return adminImageOut(image);
}

export async function editImage(who: Who, id: string, body: z.infer<typeof ImageUpdate>) {
  const existing = await db.image.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "image not found");
  const image = await db.image.update({ where: { id }, data: { ...body, tags: cleanTags(body.tags) } });
  await core().audit(who.id, "edit-image", `${image.clusterId}/${image.slug}`);
  return adminImageOut(image);
}

/** Removes the library entry only; the template or ISO stays on the cluster. */
export async function deleteImage(who: Who, id: string) {
  const image = await db.image.findUnique({ where: { id } });
  if (!image) throw new HttpError(404, "image not found");
  const waiting = await db.vm.count({
    where: { clusterId: image.clusterId, imageSlug: image.slug, status: { in: ["pending", "provisioning"] } },
  });
  if (waiting) throw new HttpError(409, "a VM request is waiting on this image; hide it instead");
  await db.image.delete({ where: { id } });
  await core().audit(who.id, "remove-image", `${image.clusterId}/${image.slug}`);
}

// -- overview, people, audit ---------------------------------------------

export async function overview() {
  const c = core();
  const now = new Date();
  const out = [];
  for (const cl of c.cfg.clusters) {
    const drv = c.driver(cl.id);
    let error: string | null = null;
    let nodes: Awaited<ReturnType<typeof drv.nodes>> = [];
    let guests: { vmid: number; status: string }[] = [];
    let gpusInUse = 0;
    let firewallOk: boolean | null = null;
    try {
      nodes = await c.cached(cl.id, "nodes", () => drv.nodes(), 15_000);
      guests = [...(await c.liveVms(cl.id)).values()].filter((v) => !v.template);
      if (hasGpus(cl)) gpusInUse = (await gpuState(c, cl)).filter((g) => g.holder).length;
      if (cl.network.isolate)
        firewallOk = await c.cached(cl.id, "dcfw", () => drv.clusterFirewallEnabled(), 60_000);
    } catch (e) {
      if (!(e instanceof ProxmoxError)) throw e;
      error = e.message;
    }
    const managed = await db.vm.findMany({
      where: { clusterId: cl.id, status: { in: ["active", "provisioning"] } },
      select: { vmid: true, ownerId: true, cores: true, memoryMb: true, diskGb: true },
    });
    const inCluster = { vm: { clusterId: cl.id, status: "active" } };
    const [pendingVms, pendingGpu, pendingServices, published, booked, upcoming, archived, images] =
      await Promise.all([
        db.vm.count({ where: { clusterId: cl.id, status: "pending" } }),
        db.vm.count({ where: { clusterId: cl.id, status: "active", gpuAccess: "requested" } }),
        db.service.count({ where: { ...inCluster, status: "pending" } }),
        db.service.count({ where: { ...inCluster, status: "published" } }),
        db.reservation.count({ where: { clusterId: cl.id, status: "active" } }),
        db.reservation.count({ where: { clusterId: cl.id, status: "scheduled", startAt: { gt: now } } }),
        db.vm.count({ where: { clusterId: cl.id, status: "archived" } }),
        db.image.count({ where: { clusterId: cl.id, enabled: true } }),
      ]);
    const known = new Set(managed.map((v) => v.vmid));
    const sum = (f: (v: (typeof managed)[number]) => number) => managed.reduce((n, v) => n + f(v), 0);
    out.push({
      id: cl.id,
      name: cl.name,
      kind: cl.kind,
      error,
      nodes,
      vms: {
        managed: managed.length,
        owners: new Set(managed.map((v) => v.ownerId)).size,
        archived,
        running: guests.filter((v) => known.has(v.vmid) && v.status === "running").length,
        unmanaged: guests.filter((v) => !known.has(v.vmid)).length,
      },
      allocated: {
        cores: sum((v) => v.cores),
        memoryMb: sum((v) => v.memoryMb),
        diskGb: sum((v) => v.diskGb),
      },
      capacity: {
        cores: nodes.reduce((n, x) => n + x.maxcpu, 0),
        memoryMb: Math.floor(nodes.reduce((n, x) => n + x.maxmem, 0) / 1024 / 1024),
      },
      gpus: hasGpus(cl) ? { total: cl.gpu.devices.length, inUse: gpusInUse, booked, upcoming } : null,
      pending: { vms: pendingVms, gpu: pendingGpu, services: pendingServices },
      network: {
        label: cl.network.label,
        isolated: cl.network.isolate,
        services: cl.network.services,
        published,
        firewallOk,
        accessPorts: cl.network.access_ports,
        accessSources: cl.network.access_sources,
        publicSources: cl.network.public_sources,
        serviceApproval: cl.network.service_approval,
        bridge: cl.bridge,
        vlan: cl.vlan,
      },
      images,
    });
  }
  return out;
}

/**
 * Per cluster: average node CPU and memory use over time, and GPU-hours booked
 * per day for the last and next week against what the pool could supply.
 */
export async function clusterMetrics(timeframe: Timeframe, today: Date) {
  const c = core();
  const from = new Date(today);
  from.setDate(from.getDate() - 7);
  const to = new Date(today);
  to.setDate(to.getDate() + 7);
  const out = [];
  for (const cl of c.cfg.clusters) {
    const drv = c.driver(cl.id);
    let load: { time: number; cpu: number; mem: number }[] = [];
    let error: string | null = null;
    try {
      load = await c.cached(
        cl.id,
        `node-metrics:${timeframe}`,
        async () => {
          const online = (await drv.nodes()).filter((n) => n.status === "online");
          const series = await Promise.all(online.map((n) => drv.nodeMetrics(n.node, timeframe)));
          // Nodes report on the same clock; bucket by timestamp and average across nodes.
          const buckets = new Map<number, { cpu: number; mem: number; maxmem: number; n: number }>();
          for (const s of series) {
            for (const p of s) {
              const b = buckets.get(p.time) ?? { cpu: 0, mem: 0, maxmem: 0, n: 0 };
              b.cpu += p.cpu;
              b.mem += p.mem;
              b.maxmem += p.maxmem;
              b.n += 1;
              buckets.set(p.time, b);
            }
          }
          return [...buckets.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([time, b]) => ({
              time: time * 1000,
              cpu: Math.round((b.cpu / b.n) * 1000) / 10,
              mem: b.maxmem ? Math.round((b.mem / b.maxmem) * 1000) / 10 : 0,
            }));
        },
        60_000,
      );
    } catch (e) {
      if (!(e instanceof ProxmoxError)) throw e;
      error = e.message;
    }
    const gpuCount = cl.gpu.devices.length;
    const bookings = gpuCount
      ? await db.reservation.findMany({
          where: { clusterId: cl.id, startAt: { lt: to }, endAt: { gt: from } },
          select: { startAt: true, endAt: true, status: true },
        })
      : [];
    out.push({
      id: cl.id,
      name: cl.name,
      error,
      load,
      gpu: gpuCount ? { capacityPerDay: gpuCount * 24, days: dailyGpuHours(bookings, from, 14) } : null,
    });
  }
  return out;
}

/** Everyone who has signed in. Infrastructure sees email and groups; that is what this view is for. */
export async function people() {
  const e = env();
  const users = await db.user.findMany({
    include: {
      accounts: { select: { accountId: true, providerId: true } },
      sessions: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    },
    orderBy: { name: "asc" },
  });
  const groups = new Map((await db.identityGroups.findMany()).map((g) => [g.sub, g.groups]));
  const counts = new Map(
    (
      await db.vm.groupBy({
        by: ["ownerId"],
        where: { status: { in: VM_LIVE } },
        _count: true,
        _sum: { cores: true, memoryMb: true },
      })
    ).map((g) => [g.ownerId, g]),
  );
  return users.map((u) => {
    const sub = u.accounts.find((a) => a.providerId === "authentik")?.accountId;
    const g = (sub && groups.get(sub)) || [];
    const n = counts.get(u.id);
    return {
      ...toPublicUser(u),
      email: u.email,
      groups: g,
      isAdmin: rolesForGroups(g, e.ADMIN_GROUPS, e.MEMBER_GROUPS).has("admin"),
      lastSignInAt: u.sessions[0]?.createdAt.toISOString() ?? null,
      vms: n?._count ?? 0,
      cores: n?._sum.cores ?? 0,
      memoryMb: n?._sum.memoryMb ?? 0,
    };
  });
}

export async function auditLog(limit: number) {
  const rows = await db.audit.findMany({
    include: { user: true },
    orderBy: { at: "desc" },
    take: Math.min(limit, 1000),
  });
  return rows.map((a) => ({
    id: a.id,
    at: a.at.toISOString(),
    user: a.user ? toPublicUser(a.user) : null,
    action: a.action,
    target: a.target,
    detail: a.detail,
  }));
}
