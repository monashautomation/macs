import { redirect } from "next/navigation";
import { env } from "@/env";
import { AUTHENTIK, getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { matchServiceKey, type Role, rolesForGroups } from "@/lib/roles";

/**
 * Who is calling. Every route and page resolves this and checks it on the
 * server; hiding a button is never the access control (audit X3).
 */
export type Principal =
  | { kind: "user"; id: string; name: string; email: string; groups: string[]; roles: Set<Role> }
  | { kind: "service"; name: string; roles: Set<Role> };

export async function getPrincipal(headers: Headers): Promise<Principal | null> {
  const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const service = matchServiceKey(bearer, env().SERVICE_KEYS);
    // Services act as members unless a route explicitly allows them more.
    return service ? { kind: "service", name: service, roles: new Set<Role>(["member"]) } : null;
  }

  const session = await getAuth().api.getSession({ headers });
  if (!session) return null;
  const groups = await groupsForUser(session.user.id);
  const e = env();
  return {
    kind: "user",
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    groups,
    roles: rolesForGroups(groups, e.ADMIN_GROUPS, e.MEMBER_GROUPS),
  };
}

/** Groups from the user's Authentik account at its last sign-in. */
async function groupsForUser(userId: string): Promise<string[]> {
  const account = await db.account.findFirst({
    where: { userId, providerId: AUTHENTIK },
    select: { accountId: true },
  });
  if (!account) return [];
  const row = await db.identityGroups.findUnique({ where: { sub: account.accountId } });
  return row?.groups ?? [];
}

type RouteContext<P> = { params: Promise<P> };
type Handler<P> = (req: Request, ctx: { principal: Principal; params: P }) => Promise<Response> | Response;

export interface RouteRule {
  /** Role the caller must hold. */
  role: Role;
  /** Allow service keys on this route (they hold `member` only). Default false. */
  services?: boolean;
}

/**
 * Wrap every API route handler:
 *   export const GET = withAuth({ role: "member" }, async (req, { principal }) => …)
 * 401 when nobody is signed in, 403 when the role is missing. Ownership checks
 * (is this *their* row?) still belong in the handler's query.
 */
export function withAuth<P = Record<string, never>>(rule: RouteRule, handler: Handler<P>) {
  return async (req: Request, ctx: RouteContext<P>): Promise<Response> => {
    const principal = await getPrincipal(req.headers);
    if (!principal) return Response.json({ error: "Sign in required" }, { status: 401 });
    if (principal.kind === "service" && !rule.services) {
      return Response.json({ error: "Not available to service keys" }, { status: 403 });
    }
    if (!principal.roles.has(rule.role)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    try {
      return await handler(req, { principal, params: (await ctx?.params) ?? ({} as P) });
    } catch (err) {
      logger.error({ err, path: new URL(req.url).pathname }, "route failed");
      return Response.json({ error: "Something went wrong" }, { status: 500 });
    }
  };
}

/** For server components and server actions: the signed-in user with `role`, or redirect. */
export async function requireUser(headers: Headers, role: Role = "member") {
  const principal = await getPrincipal(headers);
  if (!principal || principal.kind !== "user") redirect("/");
  if (!principal.roles.has(role)) redirect("/?denied=1");
  return principal;
}
