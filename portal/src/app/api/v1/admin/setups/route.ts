import { addSetup, adminSetups, SetupBody } from "@/server/handlers/infra";
import { api, readBody } from "@/server/http";

export const GET = api("admin", () => adminSetups());

export const POST = api("admin", async ({ who, req }) =>
  Response.json(await addSetup(who, await readBody(req, SetupBody)), { status: 201 }),
);
