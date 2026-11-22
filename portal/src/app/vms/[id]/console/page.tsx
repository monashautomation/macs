import { headers } from "next/headers";
import { VmConsole } from "@/components/macs/console";
import { requireUser } from "@/lib/authz";
import { session } from "@/server/handlers/vms";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireUser(await headers(), "member");
  const { consoleWsUrl } = await session(principal);
  return <VmConsole id={(await params).id} wsUrl={consoleWsUrl} />;
}
