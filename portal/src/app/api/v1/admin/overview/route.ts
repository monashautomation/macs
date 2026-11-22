import { overview } from "@/server/handlers/infra";
import { api } from "@/server/http";

export const GET = api("admin", () => overview());
