import { keepRunning } from "@/server/handlers/manage";
import { api } from "@/server/http";

/** "Keep running": dismiss the idle warning. */
export const POST = api<{ id: string }>("member", ({ who, params }) => keepRunning(who, params.id));
