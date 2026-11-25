import { createSnapshot, listSnapshots, SnapshotCreate } from "@/server/handlers/manage";
import { api, readBody } from "@/server/http";

export const GET = api<{ id: string }>("member", ({ who, params }) => listSnapshots(who, params.id));
export const POST = api<{ id: string }>("member", async ({ who, params, req }) =>
  createSnapshot(who, params.id, await readBody(req, SnapshotCreate)),
);
