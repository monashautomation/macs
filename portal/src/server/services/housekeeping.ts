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
export function localClock(at: Date, timeZone: string): { date: string; time: string; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    /** ISO: 1 = Monday ... 7 = Sunday. */
    weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday ?? "") + 1,
  };
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
    const { date, time, weekday } = localClock(now, validTimeZone(vm.scheduleTz) ? vm.scheduleTz : "UTC");
    if (vm.scheduleDays && !vm.scheduleDays.includes(String(weekday))) continue; // not one of its days
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

const idleChecked = new WeakMap<Core, number>();

/**
 * Idle VMs: running, up for the whole window, and with CPU and network flat
 * throughout it (from Proxmox's usage history). The owner is warned, and if it
 * is still idle after the grace period it is shut down; it can be started
 * again at any time. Checked hourly: the history only moves every half hour.
 */
export async function idlePass(core: Core, now: Date, force = false) {
  if (!force && now.getTime() - (idleChecked.get(core) ?? 0) < 3600_000) return;
  idleChecked.set(core, now.getTime());
  for (const cluster of core.cfg.clusters) {
    if (!cluster.idle_days) continue;
    const drv = core.driver(cluster.id);
    const vms = await db.vm.findMany({
      where: {
        clusterId: cluster.id,
        status: "active",
        vmid: { not: null },
        OR: [{ idleCheckAfter: null }, { idleCheckAfter: { lte: now } }],
        reservations: { none: { status: "active" } },
      },
    });
    for (const vm of vms) {
      const vmid = vm.vmid as number;
      let idle = false;
      const live = await locate(core, vm);
      if (live?.status === "running" && live.uptime >= cluster.idle_days * 86_400) {
        try {
          const since = now.getTime() / 1000 - cluster.idle_days * 86_400;
          const points = (await drv.vmMetrics(live.node, vmid, "week")).filter((p) => p.time >= since);
          idle =
            points.length >= cluster.idle_days * 4 && // enough history to judge
            points.every(
              (p) =>
                p.cpu * 100 < cluster.idle_cpu_percent &&
                (p.netin + p.netout) / 1024 < cluster.idle_network_kbps,
            );
        } catch {
          continue; // no history right now: leave it as it is
        }
      }
      if (!idle) {
        if (vm.idleWarnedAt) await db.vm.update({ where: { id: vm.id }, data: { idleWarnedAt: null } });
        continue;
      }
      if (!vm.idleWarnedAt) {
        await db.vm.update({ where: { id: vm.id }, data: { idleWarnedAt: now } });
        await notifyVm(
          vm.id,
          {
            kind: "vm.idle",
            title: `${vm.name} looks idle`,
            body: `It has barely used CPU or network for ${cluster.idle_days} days and will be shut down in ${cluster.idle_grace_days} days. Still need it running? Choose "Keep running" on its page.`,
          },
          { shared: true },
        );
        continue;
      }
      if (now.getTime() - vm.idleWarnedAt.getTime() < cluster.idle_grace_days * DAY || !live) continue;
      const jobId = await core.tryJob("idle-stop", vm);
      if (!jobId) continue;
      const ok = await core.runJob(jobId, async (log) => {
        log(`idle for ${cluster.idle_days + cluster.idle_grace_days} days: shutting down`);
        await drv.shutdown(live.node, vmid);
      });
      if (!ok) continue;
      await db.vm.update({ where: { id: vm.id }, data: { idleWarnedAt: null } });
      await notifyVm(
        vm.id,
        {
          kind: "vm.idle-stopped",
          title: `${vm.name} was shut down because it was idle`,
          body: "Nothing was deleted. Start it again whenever you need it.",
        },
        { shared: true },
      );
    }
  }
}

export async function housekeeping(core: Core, now = new Date()) {
  await expiryPass(core, now);
  await idlePass(core, now);
  await schedulePass(core, now);
  await deliverPending();
}
