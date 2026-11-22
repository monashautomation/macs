import { createHash, timingSafeEqual } from "node:crypto";

export type Role = "member" | "admin";

/**
 * Roles from Authentik groups. Pure, so it's unit-tested and reused by every
 * check. `memberGroups` empty means any signed-in Authentik user is a member.
 */
export function rolesForGroups(
  groups: readonly string[],
  adminGroups: readonly string[],
  memberGroups: readonly string[],
): Set<Role> {
  const roles = new Set<Role>();
  const has = (list: readonly string[]) => list.some((g) => groups.includes(g));
  const isAdmin = adminGroups.length > 0 && has(adminGroups);
  if (isAdmin || memberGroups.length === 0 || has(memberGroups)) roles.add("member");
  if (isAdmin) roles.add("admin");
  return roles;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Which service, if any, owns this bearer key. Each caller has its own key
 * (audit X5): revoke one by deleting its entry, without touching the others.
 */
export function matchServiceKey(presented: string, keys: Readonly<Record<string, string>>): string | null {
  if (!presented) return null;
  const digest = Buffer.from(sha256Hex(presented), "hex");
  for (const [name, hex] of Object.entries(keys)) {
    const expected = Buffer.from(hex, "hex");
    if (expected.length === digest.length && timingSafeEqual(expected, digest)) return name;
  }
  return null;
}
