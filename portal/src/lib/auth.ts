import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { genericOAuth } from "better-auth/plugins";
import { env } from "@/env";
import { db } from "@/lib/db";

export const AUTHENTIK = "authentik";

interface AuthentikProfile {
  sub: string;
  email: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  groups?: string[];
}

function createAuth() {
  const e = env();
  return betterAuth({
    appName: e.APP_NAME,
    baseURL: e.APP_URL,
    secret: e.BETTER_AUTH_SECRET,
    database: prismaAdapter(db, { provider: "postgresql" }),
    // Authentik is the only sign-in. No passwords, no other providers.
    emailAndPassword: { enabled: false },
    account: {
      // Never attach a new Authentik identity to an existing user because the
      // emails match: the person is their Authentik `sub` (security audit X1).
      accountLinking: { enabled: false },
    },
    session: {
      // Short sessions bound how long removed members and demoted admins keep
      // access (audit X2). Groups refresh on every sign-in.
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 60,
    },
    advanced: {
      useSecureCookies: e.NODE_ENV === "production",
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: AUTHENTIK,
            discoveryUrl: `${e.AUTHENTIK_ISSUER.replace(/\/$/, "")}/.well-known/openid-configuration`,
            clientId: e.AUTHENTIK_CLIENT_ID,
            clientSecret: e.AUTHENTIK_CLIENT_SECRET,
            scopes: ["openid", "profile", "email", "groups"],
            pkce: true,
            // Re-copy name and email from Authentik on every sign-in.
            overrideUserInfo: true,
            mapProfileToUser: async (raw: Record<string, unknown>) => {
              const p = raw as unknown as AuthentikProfile;
              // Groups are stored per Authentik subject, outside the user record,
              // so they can't be edited through any user-facing API.
              if (typeof p.sub === "string" && p.sub) {
                const groups = Array.isArray(p.groups) ? p.groups.map(String) : [];
                await db.identityGroups.upsert({
                  where: { sub: p.sub },
                  create: { sub: p.sub, groups },
                  update: { groups },
                });
              }
              return {
                email: p.email,
                emailVerified: true,
                name: p.name ?? p.preferred_username ?? p.email,
                image: p.picture,
              };
            },
          },
        ],
      }),
    ],
  });
}

let instance: ReturnType<typeof createAuth> | undefined;

/** Lazily built so importing this module never needs secrets (e.g. at build time). */
export function getAuth() {
  instance ??= createAuth();
  return instance;
}
