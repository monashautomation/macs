import type { Vm } from "@prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ClusterConfig } from "@/server/config";
import { Busy, type Core } from "@/server/core";
import { attachGpu, detachGpu } from "./gpus";

/** GPU bookings: validation and the loop that attaches/detaches GPUs on time. */

const OPEN = ["scheduled", "active"];
const HOUR = 3600_000;

export async function bookingError(
  cluster: ClusterConfig,
  vm: Pick<Vm, "id" | "status" | "gpuAccess">,
  start: Date,
  end: Date,
  now = new Date(),
): Promise<string | null> {
  const g = cluster.gpu;
  if (!g.devices.length) return `${cluster.name} has no GPUs`;
  if (vm.status !== "active") return "the VM is not active";
  if (vm.gpuAccess !== "approved") return "this VM is not approved for GPU use";
  if (end <= now) return "the booking is in the past";
  if (end <= start) return "the booking must end after it starts";
  if (end.getTime() - start.getTime() > g.max_reservation_hours * HOUR) {
    return `bookings are limited to ${g.max_reservation_hours} hours`;
  }
  if (start.getTime() > now.getTime() + g.max_advance_days * 24 * HOUR) {
    return `bookings can be made at most ${g.max_advance_days} days ahead`;
  }
  const overlapping = await db.reservation.findMany({
    where: { clusterId: cluster.id, status: { in: OPEN }, startAt: { lt: end }, endAt: { gt: start } },
    select: { vmId: true, startAt: true, endAt: true },
  });
  if (overlapping.some((r) => r.vmId === vm.id)) return "this VM already has a booking overlapping that time";
  // Peak concurrency only changes where a booking starts, so check those instants.
  for (const t of [start, ...overlapping.filter((r) => r.startAt > start).map((r) => r.startAt)]) {
    if (overlapping.filter((r) => r.startAt <= t && t < r.endAt).length >= g.devices.length) {
      return `all ${g.devices.length} GPUs are booked at ${t.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    }
  }
  return null;
}

async function tryJob(core: Core, kind: string, vm: { id: string; name: string }): Promise<string | null> {
  try {
    return await core.createJob(kind, vm, null);
  } catch (e) {
    if (e instanceof Busy) return null; // retry next tick
    throw e;
  }
}

async function finish(core: Core, resId: string) {
  const r = await db.reservation.findUniqueOrThrow({ where: { id: resId }, include: { vm: true } });
  const { vm } = r;
  const now = new Date();
  // Back-to-back booking for the same VM: hand the GPU straight over.
  const next = await db.reservation.findFirst({
    where: { vmId: vm.id, status: "scheduled", startAt: { lte: now }, endAt: { gt: now } },
  });
  if (next) {
    await db.$transaction([
      db.reservation.update({ where: { id: r.id }, data: { status: "completed" } }),
      db.reservation.update({ where: { id: next.id }, data: { status: "active", gpuId: r.gpuId } }),
    ]);
    return;
  }
  if (vm.status !== "active" || vm.vmid === null) {
    await db.reservation.update({ where: { id: r.id }, data: { status: "completed" } });
    return;
  }
  const jobId = await tryJob(core, "gpu-release", vm);
  if (!jobId) return;
  const cluster = core.cluster(vm.clusterId);
  const vmid = vm.vmid;
  const ok = await core.runJob(jobId, async (log) => {
    log(`booking ${resId} ended`);
    await detachGpu(core, cluster, vmid, log, true);
  });
  // Even if the release failed the booking is over; an unbooked holder is
  // preemptible, so the next booking will still get the GPU.
  await db.reservation.update({
    where: { id: resId },
    data: { status: "completed", error: ok ? "" : "GPU release failed - see the activity log" },
  });
}

async function begin(core: Core, resId: string) {
  const r = await db.reservation.findUniqueOrThrow({ where: { id: resId }, include: { vm: true } });
  const { vm } = r;
  const fail = (error: string) =>
    db.reservation.update({ where: { id: resId }, data: { status: "failed", error } });
  if (r.endAt <= new Date()) return fail("the booking window passed before it could start");
  if (vm.status !== "active" || vm.vmid === null) return fail("the VM is no longer active");
  const jobId = await tryJob(core, "gpu-attach", vm);
  if (!jobId) return;
  const cluster = core.cluster(vm.clusterId);
  const vmid = vm.vmid;
  let gpuId = "";
  const ok = await core.runJob(jobId, async (log) => {
    log(`booking ${resId} starting`);
    gpuId = await attachGpu(core, cluster, vmid, log, { preempt: true });
  });
  // Cancelled while attaching? Leave it; the next tick reconciles.
  if (ok) {
    await db.reservation.updateMany({
      where: { id: resId, status: "scheduled" },
      data: { status: "active", gpuId },
    });
  } else {
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { error: true } });
    await db.reservation.updateMany({
      where: { id: resId, status: "scheduled" },
      data: { status: "failed", error: job.error },
    });
  }
}

/** One scheduler pass. Serialised so passes never overlap. */
export function tick(core: Core): Promise<void> {
  return core.withLock("scheduler", async () => {
    const now = new Date();
    // Free GPUs before handing them out.
    const ending = await db.reservation.findMany({
      where: { status: "active", endAt: { lte: now } },
      select: { id: true },
    });
    for (const r of ending) await finish(core, r.id);
    const starting = await db.reservation.findMany({
      where: { status: "scheduled", startAt: { lte: now } },
      orderBy: { startAt: "asc" },
      select: { id: true },
    });
    for (const r of starting) await begin(core, r.id);
  });
}

/** Runs until the process exits. `core.kick()` triggers a pass immediately. */
export async function runScheduler(core: Core, intervalSeconds: number) {
  for (;;) {
    try {
      await tick(core);
    } catch (err) {
      logger.error({ err }, "scheduler tick failed"); // the loop must survive anything
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalSeconds * 1000);
      core.kick = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
