import { GpuAccessRequest, requestGpuAccess } from "@/server/handlers/vms";
import { api, readBody } from "@/server/http";

export const POST = api<{ id: string }>("member", async ({ who, params, req }) =>
  requestGpuAccess(who, params.id, await readBody(req, GpuAccessRequest)),
);
