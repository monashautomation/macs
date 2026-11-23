import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const tones = { primary: "bg-primary", success: "bg-success" } as const;

/**
 * A thin usage bar: quota used, capacity allocated, node load. Turns red once
 * `value / max` passes `dangerAt`, because that is when someone has to act.
 * Pass `label` (and optionally `detail`, e.g. "3/8 GB") for the caption row.
 */
export function Meter({
  value,
  max,
  label,
  detail,
  tone = "primary",
  dangerAt = 0.9,
  className,
}: {
  value: number;
  max: number;
  label?: ReactNode;
  detail?: ReactNode;
  tone?: keyof typeof tones;
  /** Fraction from which the bar is red. Use 1.01 to never warn. */
  dangerAt?: number;
  className?: string;
}) {
  const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className={className}>
      {label || detail ? (
        <div className="mb-1 flex justify-between gap-2 text-xs text-muted-foreground">
          <span>{label}</span>
          <span className="tabular-nums">{detail}</span>
        </div>
      ) : null}
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={typeof label === "string" ? label : undefined}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", fraction > dangerAt ? "bg-destructive" : tones[tone])}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
    </div>
  );
}
