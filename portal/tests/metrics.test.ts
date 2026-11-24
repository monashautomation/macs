import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { dailyGpuHours } from "@/lib/gpu-hours";
import * as infra from "@/server/handlers/infra";
import * as h from "@/server/handlers/vms";
import { expectHttp, hasDb, Portal } from "./portal";

describe("GPU hours per day", () => {
  const day = new Date(2026, 10, 23); // local midnight
  const at = (d: number, hour: number) => new Date(2026, 10, 23 + d, hour);
  it("splits bookings across midnight and ignores ones that never ran", () => {
    const days = dailyGpuHours(
      [
        { startAt: at(0, 20), endAt: at(1, 4), status: "scheduled" }, // 4 h + 4 h
        { startAt: at(1, 10), endAt: at(1, 12), status: "active" },
        { startAt: at(1, 0), endAt: at(2, 0), status: "cancelled" },
        { startAt: at(1, 0), endAt: at(2, 0), status: "failed" },
        { startAt: at(-1, 22), endAt: at(0, 1), status: "completed" }, // only 1 h is inside the window
      ],
      day,
      3,
    );
    expect(days.map((d) => d.booked)).toEqual([5, 6, 0]);
    expect(new Date(days[1]!.day).getTime()).toBe(at(1, 0).getTime());
  });
});

describe.skipIf(!hasDb)("usage history", () => {
  let p: Portal;
  beforeEach(async () => {
    p = await Portal.create();
  });

  it("returns a VM's usage for its owner only, and nothing when it is off", async () => {
    const sam = p.who("sam");
    const vm = await p.makeVm("sam", "homelab", "lab", false);
    p.homelab.guests.get(vm.vmid!)!.started = Date.now() - 3 * 3600_000; // up for three hours
    const hour = await h.vmMetrics(sam, vm.id, "hour");
    expect(hour.points.length).toBe(60);
    const first = hour.points[0]!;
    expect(first.cpu).toBeGreaterThan(0);
    expect(first.cpu).toBeLessThanOrEqual(100);
    expect(first.maxMemGb).toBe(2);
    expect(first.memGb).toBeLessThan(first.maxMemGb);
    expect(hour.points.every((x, i, all) => i === 0 || x.time > all[i - 1]!.time)).toBe(true);
    // A day view only reaches back to when the VM started.
    expect((await h.vmMetrics(sam, vm.id, "day")).points.length).toBeLessThan(48);

    await expectHttp(h.vmMetrics(p.who("alice"), vm.id, "hour"), 404);
    await p.run(h.powerVm(sam, vm.id, "stop"));
    expect((await h.vmMetrics(sam, vm.id, "hour")).points).toEqual([]);
  });

  it("summarises cluster load and GPU hours for infrastructure", async () => {
    const vm = await p.makeVm("alice");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today.getTime() + 34 * 3600_000); // tomorrow 10:00
    await db.reservation.create({
      data: {
        clusterId: "research",
        vmId: vm.id,
        userId: p.who("alice").id,
        startAt: start,
        endAt: new Date(start.getTime() + 6 * 3600_000),
      },
    });
    const [research, homelab] = await infra.clusterMetrics("day", today);
    expect(research!.load.length).toBe(48);
    expect(research!.load[0]).toMatchObject({ cpu: expect.any(Number), mem: expect.any(Number) });
    expect(research!.load.every((x) => x.cpu >= 0 && x.cpu <= 100 && x.mem > 0 && x.mem <= 100)).toBe(true);
    expect(research!.gpu!.capacityPerDay).toBe(48); // two GPUs
    expect(research!.gpu!.days.length).toBe(14);
    expect(research!.gpu!.days[8]!.booked).toBe(6); // index 7 is today
    expect(research!.gpu!.days.reduce((n, d) => n + d.booked, 0)).toBe(6);
    expect(homelab!.gpu).toBeNull();
  });
});
