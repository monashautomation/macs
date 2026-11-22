import { z } from "zod";
import { type Principal, withAuth } from "@/lib/authz";
import type { Role } from "@/lib/roles";
import { Busy } from "@/server/core";
import { ProxmoxError } from "@/server/proxmox/types";

/** A failure the caller should see, with its status code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Who = Extract<Principal, { kind: "user" }>;
export const isAdmin = (who: Who) => who.roles.has("admin");

/**
 * Route wrapper on top of the template's withAuth: signed-in users only,
 * JSON in and out, and engine errors turned into honest status codes.
 *
 *   export const POST = api("member", async ({ who, params, req }) => createVm(who, await readBody(req, Schema)))
 */
export function api<P = Record<string, never>>(
  role: Role,
  handler: (ctx: { who: Who; params: P; req: Request }) => Promise<unknown>,
) {
  return withAuth<P>({ role }, async (req, { principal, params }) => {
    if (principal.kind !== "user") return Response.json({ error: "Users only" }, { status: 403 });
    try {
      const out = await handler({ who: principal, params, req });
      if (out instanceof Response) return out;
      return Response.json(out ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof Busy) return Response.json({ error: e.message }, { status: 409 });
      if (e instanceof ProxmoxError) return Response.json({ error: e.message }, { status: 502 });
      throw e; // withAuth logs it and answers 500
    }
  });
}

/** Parse and validate a JSON body; 400 with the first problem otherwise. */
export async function readBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".");
    throw new HttpError(400, issue ? `${where ? `${where}: ` : ""}${issue.message}` : "Invalid request");
  }
  return parsed.data;
}

export function readQuery<S extends z.ZodType>(req: Request, schema: S): z.infer<S> {
  const parsed = schema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw new HttpError(400, "Invalid query");
  return parsed.data;
}

export const noBody = z.object({}).passthrough().nullable().optional();
