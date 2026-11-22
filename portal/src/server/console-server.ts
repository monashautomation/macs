import type { IncomingMessage } from "node:http";
import { type RawData, WebSocketServer } from "ws";
import { logger } from "@/lib/logger";
import type { Core } from "@/server/core";

/**
 * Websocket relay for VM consoles (noVNC in the browser <-> Proxmox).
 *
 * Next.js route handlers cannot upgrade to websockets, so this listens on its
 * own port; the ingress maps /console-ws to it. A connection is authorised by
 * the one-time token that POST /api/v1/vms/:id/console hands to the VM's owner
 * (random, single use, expires in 20 s), and must come from this app's origin.
 */
export function startConsoleServer(core: Core, port: number, appOrigin: string): WebSocketServer {
  const wss = new WebSocketServer({
    port,
    maxPayload: 16 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });
  wss.on("connection", (ws, req: IncomingMessage) => {
    const token = (req.url ?? "").match(/^\/console-ws\/([A-Za-z0-9_-]{20,})$/)?.[1];
    const entry = token && req.headers.origin === appOrigin ? core.claimConsole(token) : undefined;
    if (!entry) {
      ws.close(4403, "forbidden");
      return;
    }
    const { stream } = entry;
    stream.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
    stream.onClose(() => ws.close());
    ws.on("message", (data: RawData) => {
      stream.send(
        Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data),
      );
    });
    ws.on("close", () => stream.close());
    ws.on("error", () => stream.close());
  });
  wss.on("error", (err) => logger.error({ err, port }, "console websocket server failed"));
  wss.on("listening", () => logger.info({ port }, "console websocket relay listening"));
  return wss;
}
