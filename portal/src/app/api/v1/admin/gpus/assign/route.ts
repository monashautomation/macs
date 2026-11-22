import { assignGpu, GpuAssign } from "@/server/handlers/infra";
import { api, readBody } from "@/server/http";

export const POST = api("admin", async ({ who, req }) => assignGpu(who, await readBody(req, GpuAssign)));
