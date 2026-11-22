import { Restore, restore } from "@/server/handlers/vms";
import { api, readBody } from "@/server/http";

export const POST = api<{ id: string }>("member", async ({ who, params, req }) =>
  restore(who, params.id, await readBody(req, Restore)),
);
