import { Resize, resize } from "@/server/handlers/manage";
import { api, readBody } from "@/server/http";

export const POST = api<{ id: string }>("member", async ({ who, params, req }) =>
  resize(who, params.id, await readBody(req, Resize)),
);
