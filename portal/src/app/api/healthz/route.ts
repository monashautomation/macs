/** Liveness: the process is up. No dependencies, so a DB blip doesn't restart pods. */
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ status: "ok" });
}
