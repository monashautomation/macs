import { headers } from "next/headers";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/authz";

/** The infrastructure workspace: Systems & Infra (ADMIN_GROUPS) only. */
export default async function InfraLayout({ children }: { children: ReactNode }) {
  await requireUser(await headers(), "admin");
  return children;
}
