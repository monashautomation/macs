/** GPU-hours booked per calendar day. Shared by the server (overview) and the browser (schedule). */

export interface Booking {
  startAt: string | Date;
  endAt: string | Date;
  status: string;
}
export interface DayHours {
  /** Local midnight that starts the day, ISO. */
  day: string;
  booked: number;
}

const HOUR = 3_600_000;
const COUNTED = new Set(["scheduled", "active", "completed"]);

/**
 * Hours of GPU time booked in each of `days` consecutive days starting at
 * `from` (a midnight). A booking that spans midnight is split between days.
 * Cancelled and failed bookings never held a GPU, so they do not count.
 */
export function dailyGpuHours(bookings: Booking[], from: Date, days: number): DayHours[] {
  return Array.from({ length: days }, (_, i) => {
    const start = new Date(from);
    start.setDate(start.getDate() + i);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    let ms = 0;
    for (const b of bookings) {
      if (!COUNTED.has(b.status)) continue;
      const overlap =
        Math.min(new Date(b.endAt).getTime(), end.getTime()) -
        Math.max(new Date(b.startAt).getTime(), start.getTime());
      if (overlap > 0) ms += overlap;
    }
    return { day: start.toISOString(), booked: Math.round((ms / HOUR) * 10) / 10 };
  });
}
