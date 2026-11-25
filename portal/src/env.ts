import { z } from "zod";

/**
 * Environment, validated once on first use (not at import, so `next build`
 * works without production secrets). Secrets come from OpenBao via an
 * ExternalSecret in production; see .env.example for local values.
 */
const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Public URL of this app. All redirects and links are built from it, never from the request. */
  APP_URL: z.url(),
  APP_NAME: z.string().default("MACS"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  AUTHENTIK_ISSUER: z.url(),
  AUTHENTIK_CLIENT_ID: z.string().min(1),
  AUTHENTIK_CLIENT_SECRET: z.string().min(1),
  /** Link back to the Authentik app library ("All apps"). */
  AUTHENTIK_LIBRARY_URL: z.url().default("https://auth.monashautomation.com/if/user/#/library"),
  /** Authentik groups that make someone an admin of this app. */
  ADMIN_GROUPS: csv,
  /** Authentik groups allowed to use the app at all. Empty = any signed-in Authentik user. */
  MEMBER_GROUPS: csv,
  /**
   * Service callers, one key each: JSON object of name -> sha256 hex of the key.
   * e.g. {"discordbot":"9f86d08..."}. Generate with `node scripts/new-service-key.mjs <name>`.
   */
  SERVICE_KEYS: z
    .string()
    .default("{}")
    .transform((v, ctx) => {
      try {
        return z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).parse(JSON.parse(v));
      } catch {
        ctx.addIssue({ code: "custom", message: "SERVICE_KEYS must be JSON {name: sha256hex}" });
        return z.NEVER;
      }
    }),
  /** Clusters, limits and network policy (YAML). Secrets inside it are `${ENV_VAR}` references. */
  MACS_CONFIG: z.string().default("./config.yaml"),
  /**
   * VM consoles are relayed over a websocket, which Next.js route handlers
   * cannot serve, so the app listens on a second port for them.
   */
  CONSOLE_WS_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  /** Where browsers reach that port, e.g. wss://macs.monashautomation.com/console-ws. Default: ws(s)://<APP_URL host>:<port>/console-ws */
  CONSOLE_WS_URL: z.string().default(""),
  /** How often GPU bookings are started and ended. */
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(30),
  /**
   * Optional: notifications (VM approved, about to expire, GPU booking started...)
   * are also POSTed here as JSON, e.g. to the Discord bot. See README.
   */
  NOTIFY_WEBHOOK_URL: z.union([z.literal(""), z.url()]).default(""),
  /** Sent as "Authorization: Bearer <token>" with each notification. */
  NOTIFY_WEBHOOK_TOKEN: z.string().default(""),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

/** Test hook. */
export function resetEnvForTests(): void {
  cached = undefined;
}
