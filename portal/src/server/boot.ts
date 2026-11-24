import { env } from "@/env";
import { logger } from "@/lib/logger";
import { startConsoleServer } from "@/server/console-server";
import { core } from "@/server/core";
import { seedImages } from "@/server/services/images";
import { runScheduler } from "@/server/services/schedule";
import { seedSetups } from "@/server/services/setups";

const globalForBoot = globalThis as unknown as { macsBooted?: boolean };

/**
 * Starts the parts of the engine that live outside request handling: closing
 * out work a restart interrupted, the GPU booking scheduler, and the console
 * websocket relay. Called once per process from instrumentation.ts.
 */
export async function boot() {
  if (globalForBoot.macsBooted) return;
  globalForBoot.macsBooted = true;
  const e = env();
  const c = core(); // loads and validates the cluster config: fail fast if it is wrong
  await seedImages(c.cfg);
  await seedSetups();
  await c.recover();
  void runScheduler(c, e.SCHEDULER_INTERVAL_SECONDS);
  startConsoleServer(c, e.CONSOLE_WS_PORT, new URL(e.APP_URL).origin);
  logger.info({ clusters: c.cfg.clusters.map((x) => x.id) }, "engine started");
}
