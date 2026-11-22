import { archive } from "@/server/handlers/vms";
import { api } from "@/server/http";

export const POST = api<{ id: string }>("member", ({ who, params }) => archive(who, params.id));
