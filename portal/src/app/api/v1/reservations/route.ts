import { Booking, createReservation, listReservations, ReservationQuery } from "@/server/handlers/vms";
import { api, readBody, readQuery } from "@/server/http";

export const GET = api("member", ({ who, req }) => listReservations(who, readQuery(req, ReservationQuery)));

export const POST = api("member", async ({ who, req }) =>
  Response.json(await createReservation(who, await readBody(req, Booking)), { status: 201 }),
);
