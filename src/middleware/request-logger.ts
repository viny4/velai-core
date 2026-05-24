/**
 * Per-request observability. Tags each request with a UUID (req.requestId)
 * so downstream events — Gemini calls, agent tool calls, push fan-outs —
 * can be correlated to the request that triggered them. Logs one `api`
 * event per request on response finish.
 */
import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logEvent } from "../lib/events";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  // Skip health and the admin event reader itself to avoid log-of-log noise.
  const url = req.originalUrl.split("?")[0]!;
  if (url === "/api/health" || url.startsWith("/api/admin/events")) {
    next();
    return;
  }
  const reqId = randomUUID();
  req.requestId = reqId;
  const start = Date.now();
  res.on("finish", () => {
    const code = res.statusCode;
    logEvent({
      kind: "api",
      actorId: req.auth?.sub ?? null,
      requestId: reqId,
      durationMs: Date.now() - start,
      status: code >= 500 ? "error" : code >= 400 ? "warn" : "ok",
      message: `${req.method} ${url} → ${code}`,
      meta: { method: req.method, path: url, status_code: code },
    });
  });
  next();
}
