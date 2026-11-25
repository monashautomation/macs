import { findPeople, PeopleQuery } from "@/server/handlers/manage";
import { api, readQuery } from "@/server/http";

export const GET = api("member", async ({ who, req }) => findPeople(who, readQuery(req, PeopleQuery).q));
