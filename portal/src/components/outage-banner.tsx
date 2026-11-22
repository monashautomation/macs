import { AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Site-wide notice for outages or maintenance (feed it from the status page).
 * `warning` for degraded/maintenance, `danger` only for outages that stop work.
 */
export function OutageBanner({
  message,
  href,
  severity = "warning",
}: {
  message: string;
  href?: string;
  severity?: "info" | "warning" | "danger";
}) {
  const Icon = severity === "info" ? Info : AlertTriangle;
  return (
    <div
      role={severity === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium",
        severity === "info" && "bg-info-bg text-info",
        severity === "warning" && "bg-warning-bg text-warning",
        severity === "danger" && "bg-danger-bg text-destructive",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span>{message}</span>
      {href ? (
        <a href={href} className="text-inherit underline underline-offset-2">
          Status
        </a>
      ) : null}
    </div>
  );
}
