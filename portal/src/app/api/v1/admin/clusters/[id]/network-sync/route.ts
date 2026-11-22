import { networkSync } from "@/server/handlers/infra";
import { api } from "@/server/http";

export const POST = api<{ id: string }>("admin", ({ who, params }) => networkSync(who, params.id));
