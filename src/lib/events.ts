/**
 * Observability — append-only event log.
 *
 * `logEvent()` is fire-and-forget: it queues an INSERT into the events table
 * and never blocks the request. `withTiming()` wraps an async function and
 * emits one event per call with status + duration.
 *
 * Never throw from these helpers — observability must never break the app.
 * Never log secrets, JWT tokens, or full chat message bodies; log lengths,
 * counts, kinds.
 */
import { pool } from "../db/pool";

export type EventKind =
  | "api"          // one HTTP request lifecycle
  | "gemini"       // one Gemini REST call (translate, moderate, embed, agent)
  | "agent_turn"   // one whole /api/agent/turn (multi-hop)
  | "agent_tool"   // one tool invocation inside an agent turn
  | "push"         // one Web Push fan-out
  | "ws"           // WebSocket connect / disconnect
  | "system";      // server boot, schema sync, etc.

export type EventStatus = "ok" | "error" | "warn";

export interface EventInput {
  kind: EventKind;
  actorId?: string | null;
  requestId?: string | null;
  durationMs?: number | null;
  status?: EventStatus;
  message?: string;
  meta?: Record<string, unknown>;
  error?: string;
}

export function logEvent(e: EventInput): void {
  pool
    .query(
      `insert into events (kind, actor_id, request_id, duration_ms, status, message, meta, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        e.kind,
        e.actorId ?? null,
        e.requestId ?? null,
        e.durationMs ?? null,
        e.status ?? "ok",
        e.message ?? null,
        JSON.stringify(e.meta ?? {}),
        e.error ?? null,
      ],
    )
    .catch((err) => console.error("logEvent failed:", err));
}

/**
 * Wrap an async call: log "ok" with duration on success, "error" with the
 * thrown message on failure. Re-throws so callers behave normally.
 */
export async function withTiming<T>(
  kind: EventKind,
  base: Omit<EventInput, "kind" | "status" | "durationMs" | "error">,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    logEvent({ ...base, kind, status: "ok", durationMs: Date.now() - start });
    return result;
  } catch (e: any) {
    logEvent({
      ...base,
      kind,
      status: "error",
      durationMs: Date.now() - start,
      error: String(e?.message ?? e),
    });
    throw e;
  }
}
