import { addShare, Share } from "@/server/handlers/manage";
import { api, readBody } from "@/server/http";

export const POST = api<{ id: string }>("member", async ({ who, params, req }) =>
  addShare(who, params.id, await readBody(req, Share)),
);
