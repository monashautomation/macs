import { env } from "@/env";

/**
 * Absolute URL on this app, anchored on APP_URL.
 *
 * Never build URLs from `request.url` or the Host header: behind Cloudflare
 * Tunnel + Traefik those can be the pod's internal address (a bug discordbot
 * hit in production).
 */
export function absoluteUrl(path = "/", base: string = env().APP_URL): string {
  return new URL(safeRedirectPath(path), base).toString();
}

/**
 * Only same-site relative paths survive. Anything that a browser could treat
 * as another origin (`//host`, `/\host`, `https:`, `javascript:`) becomes "/".
 */
export function safeRedirectPath(input: string | null | undefined): string {
  if (!input) return "/";
  if (!input.startsWith("/")) return "/";
  if (input.startsWith("//") || input.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f]/.test(input)) return "/";
  return input;
}
