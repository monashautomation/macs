import { deleteSetup, editSetup, SetupBody } from "@/server/handlers/infra";
import { api, readBody } from "@/server/http";

export const PUT = api<{ id: string }>("admin", async ({ who, params, req }) =>
  editSetup(who, params.id, await readBody(req, SetupBody)),
);

export const DELETE = api<{ id: string }>("admin", ({ who, params }) => deleteSetup(who, params.id));
