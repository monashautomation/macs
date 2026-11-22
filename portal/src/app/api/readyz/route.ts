import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/** Readiness: can serve traffic (database reachable). */
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: "ready" });
  } catch (err) {
    logger.warn({ err }, "readiness check failed");
    return Response.json({ status: "not ready" }, { status: 503 });
  }
}
