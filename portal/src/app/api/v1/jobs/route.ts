import { z } from "zod";
import { listJobs } from "@/server/handlers/vms";
import { api, readQuery } from "@/server/http";

const Query = z.object({
  scope: z.enum(["mine", "all"]).default("mine"),
  limit: z.coerce.number().int().min(1).default(50),
});

export const GET = api("member", ({ who, req }) => {
  const q = readQuery(req, Query);
  return listJobs(who, q.scope, q.limit);
});
