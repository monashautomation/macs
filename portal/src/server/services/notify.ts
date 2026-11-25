import { env } from "@/env";
import { AUTHENTIK } from "@/lib/auth";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { absoluteUrl } from "@/lib/url";

/**
 * Notifications: a row per person per event, shown under the bell in the app.
 *
 * When NOTIFY_WEBHOOK_URL is set each one is also POSTed there as JSON, so
 * another service (the Discord bot) can pass it on. The payload identifies the
 * person by their Authentik `sub`, never by email:
 *
 *   { id, kind, title, body, url, user: { sub, name }, createdAt }
 *
 * Delivery is at-least-once: anything the webhook did not accept is retried by
 * the scheduler for a day, so receivers should de-duplicate on `id`.
 */
export interface Notice {
  /** Machine-readable event name, e.g. "vm.expiring". */
  kind: string;
  title: string;
  body?: string;
  /** App path to open. */
  link?: string;
}

export async function notify(userId: string, n: Notice): Promise<void> {
  try {
    const row = await db.notification.create({
      data: { userId, kind: n.kind, title: n.title, body: n.body ?? "", link: n.link ?? "" },
    });
    void deliver(row.id);
  } catch (err) {
    // A notification must never break the work that raised it.
    logger.error({ err, userId, kind: n.kind }, "could not record a notification");
  }
}

/** Notify a VM's owner and everyone it is shared with. */
export async function notifyVm(vmId: string, n: Omit<Notice, "link">, opts: { shared?: boolean } = {}) {
  const vm = await db.vm.findUnique({ where: { id: vmId }, include: { shares: true } });
  if (!vm) return;
  const people = [vm.ownerId, ...(opts.shared ? vm.shares.map((s) => s.userId) : [])];
  for (const userId of new Set(people)) await notify(userId, { ...n, link: `/vms/${vm.id}` });
}

async function deliver(id: string): Promise<boolean> {
  const e = env();
  if (!e.NOTIFY_WEBHOOK_URL) return false;
  try {
    const n = await db.notification.findUnique({ where: { id }, include: { user: true } });
    if (!n || n.deliveredAt) return true;
    const account = await db.account.findFirst({
      where: { userId: n.userId, providerId: AUTHENTIK },
      select: { accountId: true },
    });
    const res = await fetch(e.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(e.NOTIFY_WEBHOOK_TOKEN ? { Authorization: `Bearer ${e.NOTIFY_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        url: n.link ? absoluteUrl(n.link) : null,
        user: { sub: account?.accountId ?? null, name: n.user.name },
        createdAt: n.createdAt.toISOString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook answered ${res.status}`);
    await db.notification.update({ where: { id }, data: { deliveredAt: new Date() } });
    return true;
  } catch (err) {
    logger.warn({ err, notificationId: id }, "notification webhook delivery failed; will retry");
    return false;
  }
}

/** Retry what the webhook has not accepted yet (called from the scheduler). */
export async function deliverPending(): Promise<void> {
  if (!env().NOTIFY_WEBHOOK_URL) return;
  const rows = await db.notification.findMany({
    where: { deliveredAt: null, createdAt: { gt: new Date(Date.now() - 86_400_000) } },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true },
  });
  for (const r of rows) if (!(await deliver(r.id))) break; // the receiver is down: try again next pass
}
