"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A read-only value people paste somewhere else (a command, an address, a
 * token name) with a copy button. Long values scroll instead of wrapping.
 */
export function CopyField({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  /** Accessible name for the button, e.g. "Copy SSH command". */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn("flex items-stretch overflow-hidden rounded-md border border-border bg-muted", className)}
    >
      <code className="w-0 min-w-0 flex-1 overflow-x-auto px-3 py-2.5 text-xs whitespace-nowrap">
        {value}
      </code>
      <button
        type="button"
        aria-label={label}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 border-l border-border px-3 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={() =>
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        <span className="hidden sm:inline" aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </span>
      </button>
    </div>
  );
}
