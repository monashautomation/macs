import { rebuild } from "@/server/handlers/manage";
import { api } from "@/server/http";

export const POST = api<{ id: string }>("member", ({ who, params }) => rebuild(who, params.id));
