import { GpuRelease, releaseGpu } from "@/server/handlers/infra";
import { api, readBody } from "@/server/http";

export const POST = api("admin", async ({ who, req }) => releaseGpu(who, await readBody(req, GpuRelease)));
