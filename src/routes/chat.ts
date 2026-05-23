import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { isUuid } from "../lib/validate";
import { notifyUser } from "../lib/realtime";
import { notifyPush } from "../lib/push";
import { pickLang, localizeRow, detectLang, type Lang } from "../lib/i18n";
import { translate as geminiTranslate } from "../lib/gemini";

const router = Router();
router.use(requireAuth);

/** One conversation in list shape, from the caller's point of view. */
async function conversationView(id: string, userId: string, lang: Lang) {
  const r = await pool.query(
    `select c.id, c.job_id, c.last_message_at,
            j.title as job_title, j.title_ta as job_title_ta, j.title_en as job_title_en,
            case when c.worker_id = $2 then c.employer_id else c.worker_id end
              as other_id,
            case when c.worker_id = $2 then emp.full_name      else wkr.full_name      end as other_name,
            case when c.worker_id = $2 then emp.full_name_ta   else wkr.full_name_ta   end as other_name_ta,
            case when c.worker_id = $2 then emp.full_name_en   else wkr.full_name_en   end as other_name_en,
            (select m.body from messages m where m.conversation_id = c.id
             order by m.created_at desc limit 1) as last_message
     from conversations c
     join jobs j on j.id = c.job_id
     join profiles wkr on wkr.id = c.worker_id
     join profiles emp on emp.id = c.employer_id
     where c.id = $1`,
    [id, userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  localizeRow(row, lang, ["job_title", "other_name"]);
  delete row.job_title_ta; delete row.job_title_en;
  delete row.other_name_ta; delete row.other_name_en;
  return row;
}

/** GET /api/chat/conversations — the caller's conversations, newest first. */
router.get("/conversations", async (req, res) => {
  const me = req.auth!.sub;
  const lang = pickLang(req);
  const r = await pool.query(
    `select c.id, c.job_id, c.last_message_at,
            j.title as job_title, j.title_ta as job_title_ta, j.title_en as job_title_en,
            case when c.worker_id = $1 then c.employer_id else c.worker_id end
              as other_id,
            case when c.worker_id = $1 then emp.full_name      else wkr.full_name      end as other_name,
            case when c.worker_id = $1 then emp.full_name_ta   else wkr.full_name_ta   end as other_name_ta,
            case when c.worker_id = $1 then emp.full_name_en   else wkr.full_name_en   end as other_name_en,
            (select m.body from messages m where m.conversation_id = c.id
             order by m.created_at desc limit 1) as last_message
     from conversations c
     join jobs j on j.id = c.job_id
     join profiles wkr on wkr.id = c.worker_id
     join profiles emp on emp.id = c.employer_id
     where c.worker_id = $1 or c.employer_id = $1
     order by c.last_message_at desc`,
    [me],
  );
  for (const row of r.rows) {
    localizeRow(row, lang, ["job_title", "other_name"]);
    delete row.job_title_ta; delete row.job_title_en;
    delete row.other_name_ta; delete row.other_name_en;
  }
  res.json({ conversations: r.rows });
});

/**
 * POST /api/chat/conversations — open (get-or-create) a conversation.
 * Body: { job_id, worker_id? }. A conversation needs an existing job response.
 */
router.post("/conversations", async (req, res) => {
  const me = req.auth!.sub;
  const { job_id, worker_id } = req.body ?? {};
  if (!isUuid(job_id)) throw new ApiError(400, "Invalid job");

  const jr = await pool.query(
    `select posted_by from jobs where id = $1`,
    [job_id],
  );
  if (!jr.rowCount) throw new ApiError(404, "Job not found");
  const employerId = jr.rows[0]!.posted_by;

  // Caller is the employer (owns the job) or the worker (responded to it).
  let workerId: string;
  if (employerId === me) {
    if (!isUuid(worker_id)) throw new ApiError(400, "Pick a worker to message");
    workerId = worker_id;
  } else {
    workerId = me;
  }

  const resp = await pool.query(
    `select 1 from job_responses where job_id = $1 and worker_id = $2`,
    [job_id, workerId],
  );
  if (!resp.rowCount)
    throw new ApiError(
      400,
      "You can chat once the worker has shown interest in the job.",
    );

  const ins = await pool.query<{ id: string }>(
    `insert into conversations (job_id, worker_id, employer_id)
     values ($1, $2, $3)
     on conflict (job_id, worker_id) do nothing
     returning id`,
    [job_id, workerId, employerId],
  );
  const convId =
    ins.rows[0]?.id ??
    (
      await pool.query<{ id: string }>(
        `select id from conversations where job_id = $1 and worker_id = $2`,
        [job_id, workerId],
      )
    ).rows[0]!.id;

  res.json({ conversation: await conversationView(convId, me, pickLang(req)) });
});

/** Verify the caller is a participant; returns the conversation row. */
async function requireParticipant(convId: string, userId: string) {
  const r = await pool.query(
    `select id, worker_id, employer_id from conversations where id = $1`,
    [convId],
  );
  const c = r.rows[0];
  if (!c || (c.worker_id !== userId && c.employer_id !== userId))
    throw new ApiError(404, "Conversation not found");
  return c;
}

/** GET /api/chat/conversations/:id — one conversation's metadata. */
router.get("/conversations/:id", async (req, res) => {
  const me = req.auth!.sub;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Conversation not found");
  await requireParticipant(req.params.id, me);
  res.json({ conversation: await conversationView(req.params.id, me, pickLang(req)) });
});

/** GET /api/chat/conversations/:id/messages — full message history. */
router.get("/conversations/:id/messages", async (req, res) => {
  const me = req.auth!.sub;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Conversation not found");
  await requireParticipant(req.params.id, me);
  const r = await pool.query(
    `select id, conversation_id, sender_id, body, created_at
     from messages where conversation_id = $1
     order by created_at`,
    [req.params.id],
  );
  res.json({ messages: r.rows });
});

/** POST /api/chat/conversations/:id/messages — send a message. */
router.post("/conversations/:id/messages", async (req, res) => {
  const me = req.auth!.sub;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Conversation not found");
  const convo = await requireParticipant(req.params.id, me);

  const body = String(req.body?.body ?? "").trim().slice(0, 2000);
  if (!body) throw new ApiError(400, "Message cannot be empty");

  const r = await pool.query(
    `insert into messages (conversation_id, sender_id, body)
     values ($1, $2, $3)
     returning id, conversation_id, sender_id, body, created_at`,
    [req.params.id, me, body],
  );
  const message = r.rows[0]!;
  await pool.query(
    `update conversations set last_message_at = now() where id = $1`,
    [req.params.id],
  );

  // Real-time push to the other participant.
  const otherId =
    convo.worker_id === me ? convo.employer_id : convo.worker_id;
  notifyUser(otherId, {
    type: "message",
    conversation_id: req.params.id,
    message,
  });

  // Background fan-out: push notification for when the recipient isn't on the
  // page. The sender's name comes from their own JWT (saves a join).
  const senderName = req.auth!.name ?? "வேலை";
  notifyPush(otherId, {
    title: senderName,
    body: body.slice(0, 140),
    url: `/chat/${req.params.id}`,
    tag: `chat-${req.params.id}`,
  }).catch(() => {
    /* push failures must not break message sending */
  });

  res.status(201).json({ message });
});

/**
 * POST /api/chat/translate — translate one chat message on demand.
 * Body: { text }. Detects the source language, translates to the OTHER one
 * (or to `target` if supplied). Returns { text }.
 */
router.post("/translate", async (req, res) => {
  const text = String(req.body?.text ?? "").trim().slice(0, 2000);
  if (!text) throw new ApiError(400, "Nothing to translate");
  const explicit = req.body?.target;
  const target: Lang =
    explicit === "ta" || explicit === "en"
      ? explicit
      : detectLang(text) === "ta"
        ? "en"
        : "ta";
  const out = await geminiTranslate(text, target);
  res.json({ text: out ?? text });
});

export default router;
