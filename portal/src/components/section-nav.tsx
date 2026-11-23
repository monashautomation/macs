import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SectionNavItem = { label: string; href: string; active?: boolean; badge?: ReactNode };

/**
 * Second-level navigation under the AppShell, for an area with more sections
 * than the main nav should hold (an admin workspace, a settings area). A row
 * of links that scrolls sideways on phones; the active one is underlined in
 * Blue. Works in server components.
 */
export function SectionNav({
  label,
  items,
  className,
}: {
  /** Accessible name, e.g. "Infrastructure". */
  label: string;
  items: SectionNavItem[];
  className?: string;
}) {
  return (
    // The one-column grid stops a long row of links from widening the page:
    // the row scrolls inside it instead.
    <nav
      aria-label={label}
      className={cn("mb-6 grid grid-cols-[minmax(0,1fr)] border-b border-border", className)}
    >
      <div className="flex gap-1 overflow-x-auto">
        {items.map((item) => (
          <a
            key={item.href}
            href={item.href}
            aria-current={item.active ? "page" : undefined}
            className={cn(
              "inline-flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm whitespace-nowrap no-underline hover:text-foreground",
              item.active
                ? "border-primary font-semibold text-foreground"
                : "border-transparent text-muted-foreground",
            )}
          >
            {item.label}
            {item.badge}
          </a>
        ))}
      </div>
    </nav>
  );
}
