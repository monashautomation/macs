import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

export type StatusTone = "success" | "warning" | "info" | "danger" | "neutral";

const toneToVariant = {
  success: "success",
  warning: "warning",
  info: "info",
  danger: "danger",
  neutral: "secondary",
} as const;

/**
 * Status colours carry meaning only: blue/info is normal, red/danger only when
 * someone needs to act. Map your app's states to a tone once and reuse it.
 */
export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <Badge variant={toneToVariant[tone]}>{children}</Badge>;
}
