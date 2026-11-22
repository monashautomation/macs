import { cancelReservation } from "@/server/handlers/vms";
import { api } from "@/server/http";

export const DELETE = api<{ id: string }>("member", ({ who, params }) => cancelReservation(who, params.id));
