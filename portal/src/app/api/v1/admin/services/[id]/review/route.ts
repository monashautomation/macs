import { reviewService, ServiceReview } from "@/server/handlers/infra";
import { api, readBody } from "@/server/http";

export const POST = api<{ id: string }>("admin", async ({ who, params, req }) =>
  reviewService(who, params.id, await readBody(req, ServiceReview)),
);
