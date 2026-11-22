import { z } from "zod";
import { createVm, listVms, VmCreate } from "@/server/handlers/vms";
import { api, readBody, readQuery } from "@/server/http";

const Query = z.object({ scope: z.enum(["mine", "all"]).default("mine") });

export const GET = api("member", ({ who, req }) => listVms(who, readQuery(req, Query).scope));

export const POST = api("member", async ({ who, req }) =>
  Response.json(await createVm(who, await readBody(req, VmCreate)), { status: 201 }),
);
