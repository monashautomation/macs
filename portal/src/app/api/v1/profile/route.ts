import { Keys, saveProfile } from "@/server/handlers/manage";
import { api, readBody } from "@/server/http";

export const PUT = api("member", async ({ who, req }) => saveProfile(who, await readBody(req, Keys)));
