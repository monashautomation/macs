import { z } from "zod";
import { clusterMetrics } from "@/server/handlers/infra";
import { api, readQuery } from "@/server/http";

// `today` is the viewer's local midnight, so days line up with their calendar.
const Query = z.object({ timeframe: z.enum(["hour", "day", "week"]).default("day"), today: z.coerce.date() });

export const GET = api("admin", ({ req }) => {
  const q = readQuery(req, Query);
  return clusterMetrics(q.timeframe, q.today);
});
