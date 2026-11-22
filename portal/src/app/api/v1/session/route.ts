import { session } from "@/server/handlers/vms";
import { api } from "@/server/http";

export const GET = api("member", ({ who }) => session(who));
