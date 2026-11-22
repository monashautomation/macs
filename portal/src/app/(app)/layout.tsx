import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Frame } from "@/components/macs/frame";
import { requireUser } from "@/lib/authz";
import { frameProps } from "@/lib/frame-props";

export const dynamic = "force-dynamic";

/** Every page in here needs a signed-in member; the API routes check again on their own. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const principal = await requireUser(await headers(), "member");
  return <Frame {...frameProps(principal)}>{children}</Frame>;
}
