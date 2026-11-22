import { BackupCreate, createBackup } from "@/server/handlers/vms";
import { api, readBody } from "@/server/http";

export const POST = api<{ id: string }>("member", async ({ who, params, req }) =>
  createBackup(who, params.id, await readBody(req, BackupCreate)),
);
