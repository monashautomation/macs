import type { ReactNode } from "react";

/** What a list or page shows when there's nothing yet, with the one next step. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl bg-card px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-muted-foreground [&_svg]:size-10">{icon}</div> : null}
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
