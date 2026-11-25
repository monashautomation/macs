"use client";

import { Button } from "@monashautomation/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@monashautomation/ui/popover";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api, useAct, useNotifications } from "@/lib/client";
import { relTime } from "./common";

/** The bell in the header: what has happened to your VMs since you last looked. */
export function NotificationBell() {
  const q = useNotifications();
  const [open, setOpen] = useState(false);
  const read = useAct(() => api("/notifications", { method: "POST", body: {} }), { quiet: true });
  const unread = q.data?.unread ?? 0;
  const items = q.data?.items ?? [];
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Opening the list is reading it; mark on close so new ones stay highlighted while it is open.
        if (!next && unread) read.mutate();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell aria-hidden />
          {unread ? (
            <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground tabular-nums">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <p className="border-b border-border px-3 py-2 text-sm font-semibold">Notifications</p>
        {items.length ? (
          <ul className="max-h-96 overflow-y-auto text-sm">
            {items.map((n) => {
              const body = (
                <>
                  <span className="flex items-baseline gap-2">
                    {!n.read ? (
                      <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden />
                    ) : null}
                    <span className={n.read ? "" : "font-semibold"}>{n.title}</span>
                  </span>
                  {n.body ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{n.body}</span>
                  ) : null}
                  <span className="mt-0.5 block text-xs text-muted-foreground">{relTime(n.createdAt)}</span>
                </>
              );
              return (
                <li key={n.id} className="border-b border-border last:border-0">
                  {n.link ? (
                    <Link
                      href={n.link}
                      className="block px-3 py-2 text-foreground no-underline hover:bg-muted"
                      onClick={() => setOpen(false)}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="px-3 py-2">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing yet. Approvals, expiry warnings and GPU bookings show up here.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
