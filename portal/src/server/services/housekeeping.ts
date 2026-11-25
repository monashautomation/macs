import type { Vm } from "@prisma/client";
import { db } from "@/lib/db";
import type { Core } from "@/server/core";
import { deliverPending, notifyVm } from "./notify";
import { locate } from "./vms";

/**
 * The scheduler's chores besides GPU bookings: warning about and shutting down
 * expired VMs, daily power schedules, and retrying notification delivery.
 */

const DAY = 86_400_000;

/** The date and time of day in a time zone, as sortable strings. */
export function localClock(at: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const dateText = (d: Date) => d.toISOString().slice(0, 10);

async function expiryPass(core: Core, now: Date) {
  for (const cluster of core.cfg.clusters) {
    if (!cluster.lifetime_days) continue;
    const soon = new Date(now.getTime() + cluster.expiry_warning_days * DAY);
    const warn = await db.vm.findMany({
      where: {
        clusterId: cluster.id,
        status: "active",
        expired: false,
        expiryWarnedAt: null,
        expiresAt: { gt: now, lte: soon },
      },
    });
    for (const vm of warn) {
      await db.vm.update({ where: { id: vm.id }, data: { expiryWarnedAt: now } });
      await notifyVm(
        vm.id,
        {
          kind: "vm.expiring",
          title: `${vm.name} will be shut down on ${dateText(vm.expiresAt as Date)}`,
          body: "Still using it? Extend it from its page. Nothing is deleted when it shuts down.",
        },
        { shared: true },
      );
    }
    const due = await db.vm.findMany({
      where: { clusterId: cluster.id, status: "active", expired: false, expiresAt: { lte: now } },
    });
    for (const vm of due) await expire(core, vm);
  }
}

async function expire(core: Core, vm: Vm) {
  const jobId = await core.tryJob("expire", vm);
  if (!jobId) return; // busy: next pass
  const ok = await core.runJob(jobId, async (log) => {
    const live = await locate(core, vm);
    if (live && vm.vmid !== null && live.status !== "stopped") {
      log("expired: shutting down");
      await core.driver(vm.clusterId).shutdown(live.node, vm.vmid);
    }
    log("expired; extend it to use it again");
  });
  if (!ok) return;
  await db.vm.update({ where: { id: vm.id }, data: { expired: true } });
  // Its GPU time goes back to the pool: the scheduler releases the device next pass.
  await db.reservation.updateMany({
    where: { vmId: vm.id, status: "scheduled" },
    data: { status: "cancelled" },
  });
  await db.reservation.updateMany({ where: { vmId: vm.id, status: "active" }, data: { endAt: new Date() } });
  await notifyVm(
    vm.id,
    {
      kind: "vm.expired",
      title: `${vm.name} expired and was shut down`,
      body: "Its disk and settings are kept. Extend it from its page to start it again.",
    },
    { shared: true },
  );
}

async function schedulePass(core: Core, now: Date) {
  const vms = await db.vm.findMany({
    where: {
      status: "active",
      vmid: { not: null },
      OR: [{ autoStart: { not: "" } }, { autoStop: { not: "" } }],
    },
  });
  for (const vm of vms) {
    const { date, time } = localClock(now, validTimeZone(vm.scheduleTz) ? vm.scheduleTz : "UTC");
    const stopDue = !!vm.autoStop && time >= vm.autoStop && vm.lastAutoStop !== date;
    const startDue = !!vm.autoStart && time >= vm.autoStart && vm.lastAutoStart !== date;
    if (!stopDue && !startDue) continue;
    // Both overdue (the portal was down): only the later one of the day matters.
    const action: "start" | "stop" =
      stopDue && startDue ? (vm.autoStart > vm.autoStop ? "start" : "stop") : stopDue ? "stop" : "start";
    const done = { ...(stopDue ? { lastAutoStop: date } : {}), ...(startDue ? { lastAutoStart: date } : {}) };
    const live = await locate(core, vm);
    const vmid = vm.vmid as number;
    if (!live) continue;
    if (action === "stop") {
      // Never pull a VM out from under a GPU booking; stop it once the booking is over.
      if (await db.reservation.count({ where: { vmId: vm.id, status: "active" } })) continue;
      if (live.status === "running") {
        const jobId = await core.tryJob("auto-stop", vm);
        if (!jobId) continue;
        await core.runJob(jobId, async (log) => {
          log(`scheduled stop (${vm.autoStop} ${vm.scheduleTz})`);
          await core.driver(vm.clusterId).shutdown(live.node, vmid);
        });
      }
    } else if (live.status === "stopped" && !vm.expired) {
      const jobId = await core.tryJob("auto-start", vm);
      if (!jobId) continue;
      await core.runJob(jobId, async (log) => {
        log(`scheduled start (${vm.autoStart} ${vm.scheduleTz})`);
        await core.driver(vm.clusterId).start(live.node, vmid);
      });
    }
    await db.vm.update({ where: { id: vm.id }, data: done });
  }
}

export async function housekeeping(core: Core, now = new Date()) {
  await expiryPass(core, now);
  await schedulePass(core, now);
  await deliverPending();
}
