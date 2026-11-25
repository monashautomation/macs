import { listNotifications, markNotificationsRead } from "@/server/handlers/manage";
import { api } from "@/server/http";

export const GET = api("member", ({ who }) => listNotifications(who));
/** Mark everything read. */
export const POST = api("member", ({ who }) => markNotificationsRead(who));
