import type { ReactNode } from "react";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A titled section of a page: heading on the left, its actions on the right,
 * content below. The compact everyday use of Card. Brand rule still applies:
 * one primary (Blue) button per view, so `actions` are usually outline.
 */
export function SectionCard({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-4 py-5", className)}>
      {title || actions ? (
        <CardHeader className="px-5">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base leading-7">{title}</CardTitle>
          {actions ? <CardAction className="flex flex-wrap justify-end gap-2">{actions}</CardAction> : null}
        </CardHeader>
      ) : null}
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  );
}
