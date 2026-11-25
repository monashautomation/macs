import { Schedule, setSchedule } from "@/server/handlers/manage";
import { api, readBody } from "@/server/http";

export const PUT = api<{ id: string }>("member", async ({ who, params, req }) =>
  setSchedule(who, params.id, await readBody(req, Schedule)),
);
