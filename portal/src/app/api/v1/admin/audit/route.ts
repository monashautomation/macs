import { z } from "zod";
import { auditLog } from "@/server/handlers/infra";
import { api, readQuery } from "@/server/http";

export const GET = api("admin", ({ req }) =>
  auditLog(readQuery(req, z.object({ limit: z.coerce.number().int().min(1).default(200) })).limit),
);
