import { Review, reviewVm } from "@/server/handlers/infra";
import { api, readBody } from "@/server/http";

export const POST = api<{ id: string }>("admin", async ({ who, params, req }) =>
  reviewVm(who, params.id, await readBody(req, Review)),
);
