import { resetPassword } from "@/server/handlers/manage";
import { api } from "@/server/http";

export const POST = api<{ id: string }>("member", ({ who, params }) => resetPassword(who, params.id));
