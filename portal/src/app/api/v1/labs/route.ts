import { createLab, LabCreate, listLabs } from "@/server/handlers/manage";
import { api, readBody } from "@/server/http";

export const GET = api("member", ({ who }) => listLabs(who));
export const POST = api("member", async ({ who, req }) =>
  Response.json(await createLab(who, await readBody(req, LabCreate)), { status: 201 }),
);
