/**
 * What other people may see about a user. Return this from APIs by default;
 * email, groups and other personal data only in views that need them
 * (security audit X6).
 */
export type PublicUser = { id: string; name: string; image: string | null };

export function toPublicUser(u: { id: string; name: string; image?: string | null }): PublicUser {
  return { id: u.id, name: u.name, image: u.image ?? null };
}
