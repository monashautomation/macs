import { Adopt, adopt } from "@/server/handlers/infra";
import { api, readBody } from "@/server/http";

export const POST = api("admin", async ({ who, req }) =>
  Response.json(await adopt(who, await readBody(req, Adopt)), { status: 201 }),
);
