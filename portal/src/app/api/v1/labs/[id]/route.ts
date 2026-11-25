import { deleteLab } from "@/server/handlers/manage";
import { api } from "@/server/http";

export const DELETE = api<{ id: string }>("member", ({ who, params }) => deleteLab(who, params.id));
