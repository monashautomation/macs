import { removeService } from "@/server/handlers/vms";
import { api } from "@/server/http";

export const DELETE = api<{ id: string }>("member", ({ who, params }) => removeService(who, params.id));
