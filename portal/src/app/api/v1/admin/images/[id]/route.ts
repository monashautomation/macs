import { deleteImage, editImage, ImageUpdate } from "@/server/handlers/infra";
import { api, readBody } from "@/server/http";

export const PUT = api<{ id: string }>("admin", async ({ who, params, req }) =>
  editImage(who, params.id, await readBody(req, ImageUpdate)),
);

export const DELETE = api<{ id: string }>("admin", ({ who, params }) => deleteImage(who, params.id));
