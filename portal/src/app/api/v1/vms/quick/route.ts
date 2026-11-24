import { QuickDeploy, quickDeploy } from "@/server/handlers/vms";
import { api, readBody } from "@/server/http";

export const POST = api("member", async ({ who, req }) =>
  Response.json(await quickDeploy(who, await readBody(req, QuickDeploy)), { status: 201 }),
);
