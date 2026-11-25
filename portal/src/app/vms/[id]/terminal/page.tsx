import { headers } from "next/headers";
import { VmTerminal } from "@/components/macs/terminal";
import { requireUser } from "@/lib/authz";
import { session } from "@/server/handlers/vms";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireUser(await headers(), "member");
  const { consoleWsUrl } = await session(principal);
  return <VmTerminal id={(await params).id} wsUrl={consoleWsUrl} />;
}
