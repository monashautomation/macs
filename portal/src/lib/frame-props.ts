import { env } from "@/env";
import type { Principal } from "@/lib/authz";
import { canUse, config, hasGpus } from "@/server/config";

/** What the app frame needs to draw the nav for this person. */
export function frameProps(principal: Extract<Principal, { kind: "user" }>) {
  const e = env();
  const clusters = config().clusters.filter((c) => canUse(c, principal));
  return {
    appName: e.APP_NAME,
    libraryUrl: e.AUTHENTIK_LIBRARY_URL,
    userName: principal.name,
    isAdmin: principal.roles.has("admin"),
    hasGpus: clusters.some(hasGpus),
    hasServices: clusters.some((c) => c.network.services),
  };
}
