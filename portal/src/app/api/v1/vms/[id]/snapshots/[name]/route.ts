import { deleteSnapshot, rollback } from "@/server/handlers/manage";
import { api } from "@/server/http";

type P = { id: string; name: string };
/** Roll the VM back to this snapshot. */
export const POST = api<P>("member", ({ who, params }) => rollback(who, params.id, params.name));
export const DELETE = api<P>("member", ({ who, params }) => deleteSnapshot(who, params.id, params.name));
