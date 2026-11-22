import { openConsole } from "@/server/handlers/vms";
import { api } from "@/server/http";

export const POST = api<{ id: string }>("member", ({ who, params }) => openConsole(who, params.id));
