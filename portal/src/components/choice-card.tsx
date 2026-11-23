import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One option in a small set the person picks from by looking (a plan, an
 * image, a location), where a Select would hide what they are choosing
 * between. A toggle button: the chosen one has a Blue border.
 */
export function ChoiceCard({
  selected,
  title,
  description,
  children,
  className,
  ...props
}: Omit<ComponentProps<"button">, "title"> & {
  selected: boolean;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "min-h-11 rounded-lg border p-3 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        selected ? "border-primary bg-info-bg" : "border-border bg-card hover:bg-accent",
        className,
      )}
      {...props}
    >
      <span className="flex flex-wrap items-center gap-2 font-semibold">{title}</span>
      {description ? <span className="mt-1 block text-xs text-muted-foreground">{description}</span> : null}
      {children ? <span className="mt-1.5 flex flex-wrap gap-1">{children}</span> : null}
    </button>
  );
}
