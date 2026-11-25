import { removeShare } from "@/server/handlers/manage";
import { api } from "@/server/http";

export const DELETE = api<{ id: string; userId: string }>("member", ({ who, params }) =>
  removeShare(who, params.id, params.userId),
);
