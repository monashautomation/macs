import { z } from "zod";
import { unmanaged } from "@/server/handlers/infra";
import { api, readQuery } from "@/server/http";

export const GET = api("admin", ({ req }) =>
  unmanaged(readQuery(req, z.object({ clusterId: z.string() })).clusterId),
);
