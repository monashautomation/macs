import { retrySetup } from "@/server/handlers/vms";
import { api } from "@/server/http";

/** Retry a setup that failed to install. */
export const POST = api<{ id: string }>("member", ({ who, params }) => retrySetup(who, params.id));
