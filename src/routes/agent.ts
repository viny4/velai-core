/**
 * Conversational AI agent for the voice assistant.
 *
 *   POST /api/agent/turn
 *     body: { message: string, history?: AgentTurn[] }
 *     returns: { reply: string, history: AgentTurn[], actions: string[] }
 *
 * The browser owns the conversation history and sends it back each turn.
 * Stateless on the wire; the user can refresh / switch tabs without losing
 * context (as long as the browser keeps the history in local state).
 *
 * Tool execution loop (max 3 hops to keep latency bounded):
 *   1. Gemini sees the message → returns either text OR a tool_call.
 *   2. If tool_call: execute → append result → call Gemini again.
 *   3. Repeat until Gemini returns text (the spoken reply).
 */
import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { pickLang } from "../lib/i18n";
import { agentTurn, type AgentTurn } from "../lib/gemini";
import {
  TOOL_SCHEMAS,
  TOOL_HANDLERS,
  buildSystemPrompt,
  type AgentContext,
} from "../lib/agent-tools";
import { logEvent } from "../lib/events";

const router = Router();
router.use(requireAuth);

router.post("/turn", async (req, res) => {
  const userId = req.auth!.sub;
  const requestId = req.requestId ?? null;
  const turnStart = Date.now();
  const message = String(req.body?.message ?? "").trim().slice(0, 2000);
  if (!message) throw new ApiError(400, "Empty message");

  // Cap incoming history so prompts stay small and costs stay bounded.
  const rawHistory: AgentTurn[] = Array.isArray(req.body?.history)
    ? req.body.history.slice(-20)
    : [];

  // Build context — every tool will read userId + village/district from here.
  const p = await pool.query<{
    full_name: string; district: string; village: string;
    pincode: string | null; lat: number | null; lng: number | null;
  }>(
    `select full_name, district, village, pincode, lat, lng from profiles where id = $1`,
    [userId],
  );
  if (!p.rowCount) throw new ApiError(404, "Profile not found");
  const ctx: AgentContext = {
    userId,
    lang: pickLang(req),
    district: p.rows[0]!.district,
    village: p.rows[0]!.village,
    pincode: p.rows[0]!.pincode,
    lat: p.rows[0]!.lat,
    lng: p.rows[0]!.lng,
    name: p.rows[0]!.full_name,
  };
  const systemPrompt = buildSystemPrompt(ctx);

  // The working history we'll send back to the client.
  const history: AgentTurn[] = [...rawHistory, { role: "user", text: message }];
  const actions: string[] = [];

  // Tool-execution loop: at most 3 hops (model → tool → model → tool → model).
  for (let hop = 0; hop < 3; hop++) {
    const reply = await agentTurn(history, TOOL_SCHEMAS, systemPrompt);
    if (!reply) {
      const fallback =
        ctx.lang === "ta"
          ? "மன்னிக்கணும், இப்போ உதவ முடியவில்லை. மீண்டும் முயற்சி செய்யுங்க."
          : "Sorry — I can't help right now. Please try again.";
      history.push({ role: "model", text: fallback });
      return res.json({ reply: fallback, history, actions });
    }
    if (reply.kind === "text") {
      history.push({ role: "model", text: reply.text });
      logEvent({
        kind: "agent_turn",
        actorId: userId,
        requestId,
        durationMs: Date.now() - turnStart,
        status: "ok",
        message: `text reply (${actions.length} tool${actions.length === 1 ? "" : "s"})`,
        meta: {
          input_chars: message.length,
          reply_chars: reply.text.length,
          hops: hop + 1,
          tools: actions,
          history_in: rawHistory.length,
          lang: ctx.lang,
        },
      });
      return res.json({ reply: reply.text, history, actions });
    }
    // tool_call — record it, run it, feed the result back into the loop.
    const handler = TOOL_HANDLERS[reply.name];
    history.push({ role: "tool_call", name: reply.name, args: reply.args });
    actions.push(reply.name);
    const toolStart = Date.now();
    let result: any;
    let toolStatus: "ok" | "error" = "ok";
    let toolError: string | undefined;
    if (!handler) {
      result = { error: `Unknown tool: ${reply.name}` };
      toolStatus = "error";
      toolError = `Unknown tool: ${reply.name}`;
    } else {
      try {
        result = await handler(ctx, reply.args);
        if (result && typeof result === "object" && "error" in result) {
          toolStatus = "error";
          toolError = String(result.error);
        }
      } catch (e: any) {
        result = { error: String(e?.message ?? "tool failed") };
        toolStatus = "error";
        toolError = String(e?.message ?? "tool failed");
      }
    }
    logEvent({
      kind: "agent_tool",
      actorId: userId,
      requestId,
      durationMs: Date.now() - toolStart,
      status: toolStatus,
      message: `${reply.name}${toolStatus === "error" ? " failed" : ""}`,
      meta: {
        tool: reply.name,
        args: reply.args,
        result_summary:
          result && typeof result === "object"
            ? Object.keys(result).slice(0, 5)
            : typeof result,
        hop,
      },
      error: toolError,
    });
    history.push({ role: "tool_result", name: reply.name, result });
  }

  // Ran out of hops — speak something safe.
  const safety =
    ctx.lang === "ta"
      ? "இன்னும் கொஞ்சம் சொல்லுங்க — என்ன செய்ய வேண்டும்?"
      : "I need a bit more to go on — what should I do?";
  history.push({ role: "model", text: safety });
  res.json({ reply: safety, history, actions });
});

export default router;
