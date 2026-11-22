import { LayoutGrid } from "lucide-react";
import type { ReactNode } from "react";
import { MaLogo } from "@/components/ma-logo";
import { cn } from "@/lib/utils";

export type AppNavItem = { label: string; href: string; icon?: ReactNode; active?: boolean };

/**
 * Shared Monash Automation app frame: logo, app name, primary nav, a link back
 * to the Authentik app library, and a slot for the user menu. On phones the
 * nav moves to a bottom bar (the inventory pattern), labels always visible.
 * Works in server components; pass client widgets (sign-out) via `user`.
 */
export function AppShell({
  appName,
  appHref = "/",
  libraryUrl = "https://auth.monashautomation.com/if/user/#/library",
  nav = [],
  user,
  banner,
  children,
}: {
  appName: string;
  appHref?: string;
  libraryUrl?: string;
  nav?: AppNavItem[];
  user?: ReactNode;
  /** e.g. <OutageBanner />, shown above the header */
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      {banner}
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4">
          <a href={appHref} className="flex items-center gap-3 text-foreground no-underline">
            <MaLogo title="" className="h-7 w-auto" />
            <span className="border-l border-border pl-3 text-lg font-semibold">{appName}</span>
          </a>
          {nav.length > 0 ? (
            <nav aria-label="Main" className="ml-4 hidden items-center gap-1 md:flex">
              {nav.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  aria-current={item.active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-foreground no-underline hover:bg-accent",
                    item.active && "bg-accent",
                  )}
                >
                  {item.icon}
                  {item.label}
                </a>
              ))}
            </nav>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <a
              href={libraryUrl}
              className="inline-flex h-11 items-center gap-2 rounded-md px-3 text-sm text-foreground no-underline hover:bg-accent"
            >
              <LayoutGrid className="size-4" aria-hidden />
              <span className="hidden sm:inline">All apps</span>
            </a>
            {user}
          </div>
        </div>
      </header>
      <main className={cn("mx-auto max-w-7xl px-4 py-8", nav.length > 0 && "pb-24 md:pb-8")}>{children}</main>
      {nav.length > 0 ? (
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card md:hidden"
        >
          {nav.slice(0, 5).map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-xs text-muted-foreground no-underline",
                item.active && "font-semibold text-foreground",
              )}
            >
              {item.icon}
              {item.label}
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
