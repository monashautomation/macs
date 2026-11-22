import { withAuth } from "@/lib/authz";

/** The caller's own identity and roles. Their own email is fine to return to them. */
export const GET = withAuth({ role: "member", services: true }, (_req, { principal }) => {
  if (principal.kind === "service") {
    return Response.json({ kind: "service", name: principal.name, roles: [...principal.roles] });
  }
  return Response.json({
    kind: "user",
    id: principal.id,
    name: principal.name,
    email: principal.email,
    roles: [...principal.roles],
  });
});
