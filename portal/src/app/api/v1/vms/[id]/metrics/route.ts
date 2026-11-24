import { MetricsQuery, vmMetrics } from "@/server/handlers/vms";
import { api, readQuery } from "@/server/http";

export const GET = api<{ id: string }>("member", ({ who, params, req }) =>
  vmMetrics(who, params.id, readQuery(req, MetricsQuery).timeframe),
);
