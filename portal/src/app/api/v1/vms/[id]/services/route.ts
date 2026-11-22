import { publishService, ServiceCreate } from "@/server/handlers/vms";
import { api, readBody } from "@/server/http";

export const POST = api<{ id: string }>("member", async ({ who, params, req }) =>
  Response.json(await publishService(who, params.id, await readBody(req, ServiceCreate)), { status: 201 }),
);
