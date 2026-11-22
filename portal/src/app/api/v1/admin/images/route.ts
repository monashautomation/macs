import { z } from "zod";
import { addImage, adminImages, ImageCreate } from "@/server/handlers/infra";
import { api, readBody, readQuery } from "@/server/http";

export const GET = api("admin", ({ req }) =>
  adminImages(readQuery(req, z.object({ clusterId: z.string() })).clusterId),
);

export const POST = api("admin", async ({ who, req }) =>
  Response.json(await addImage(who, await readBody(req, ImageCreate)), { status: 201 }),
);
