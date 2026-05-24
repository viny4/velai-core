/**
 * Real-time delivery over WebSockets.
 *
 * Each browser opens one authenticated WebSocket (?token=<jwt>). The server
 * keeps an in-memory map of userId → open sockets — this is the pub/sub
 * routing layer. When a chat message is saved, notifyUser() pushes it to the
 * recipient's sockets instantly.
 *
 * (At multi-server scale this map would move to Redis pub/sub; for a single
 *  instance the in-memory map is the same idea, in-process.)
 */
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { verifyToken } from "./jwt";
import { logEvent } from "./events";

const userSockets = new Map<string, Set<WebSocket>>();

export function attachRealtime(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    let userId: string;
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      userId = verifyToken(url.searchParams.get("token") ?? "").sub;
    } catch {
      ws.close(4001, "unauthorized");
      logEvent({
        kind: "ws",
        status: "warn",
        message: "ws unauthorized",
        meta: { op: "connect_rejected" },
      });
      return;
    }

    let set = userSockets.get(userId);
    if (!set) {
      set = new Set();
      userSockets.set(userId, set);
    }
    set.add(ws);
    ws.send(JSON.stringify({ type: "ready" }));
    const openedAt = Date.now();
    logEvent({
      kind: "ws",
      actorId: userId,
      message: "ws connected",
      meta: { op: "connect", concurrent: set.size },
    });

    ws.on("close", () => {
      const s = userSockets.get(userId);
      s?.delete(ws);
      if (s && s.size === 0) userSockets.delete(userId);
      logEvent({
        kind: "ws",
        actorId: userId,
        durationMs: Date.now() - openedAt,
        message: "ws disconnected",
        meta: { op: "disconnect", remaining: s?.size ?? 0 },
      });
    });
    ws.on("error", () => {});
  });

  // Keep-alive ping so idle connections survive proxies.
  setInterval(() => {
    for (const set of userSockets.values()) {
      for (const ws of set) {
        try {
          ws.ping();
        } catch {
          /* socket will be cleaned up on close */
        }
      }
    }
  }, 30_000);

  console.log("✓ WebSocket server ready on /ws");
}

/** Push a JSON payload to every open socket of a user (no-op if offline). */
export function notifyUser(userId: string, payload: unknown): void {
  const set = userSockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    } catch {
      /* ignore */
    }
  }
}
