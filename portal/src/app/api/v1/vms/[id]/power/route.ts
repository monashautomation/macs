import { Power, powerVm } from "@/server/handlers/vms";
import { api, readBody } from "@/server/http";

export const POST = api<{ id: string }>("member", async ({ who, params, req }) =>
  powerVm(who, params.id, (await readBody(req, Power)).action),
);
