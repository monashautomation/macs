import { deleteVm, vmDetail } from "@/server/handlers/vms";
import { api } from "@/server/http";

export const GET = api<{ id: string }>("member", ({ who, params }) => vmDetail(who, params.id));

export const DELETE = api<{ id: string }>("member", ({ who, params }) => deleteVm(who, params.id));
