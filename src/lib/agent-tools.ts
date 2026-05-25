/**
 * Agent tools — the actions the AI voice assistant can take on behalf of the
 * signed-in user. The agent picks one based on what the user said; the route
 * executes it; the result is fed back into Gemini so it can reply naturally.
 *
 * Authorization is enforced INSIDE each handler — every tool takes userId
 * from req.auth and re-checks ownership. The agent can never act on someone
 * else's account, even if Gemini hallucinates one.
 */
import { pool } from "../db/pool";
import { JOB_TYPES } from "../db/schema";
import { embedAndStoreJob } from "./embeddings";
import { notifyNewJobNearby } from "./push";
import { translatePair, transliteratePair, type Lang } from "./i18n";
import { moderateJob, type FunctionDecl } from "./gemini";

export interface AgentContext {
  userId: string;
  lang: Lang;
  district: string;
  village: string;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
  name: string;
}

// ─── Schemas Gemini sees ────────────────────────────────────────────────────

export const TOOL_SCHEMAS: FunctionDecl[] = [
  {
    name: "post_job",
    description:
      "Post a new daily-wage job on behalf of the signed-in user. Only call this AFTER the user has confirmed all the details out loud.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short job title in the user's language." },
        job_type: {
          type: "string",
          enum: [...JOB_TYPES],
          description:
            "Choose the MOST SPECIFIC category. Be strict: coconut tree work → coconut_climbing (NOT farming); cattle/cow → cattle_care; tractor → tractor_driving; painting → painting; cooking → cooking; elderly/old-age care → elderly_care; construction → construction; house work → housework; paddy/harvest/crops → farming; only use 'other' when nothing else fits.",
        },
        wage_amount: { type: "number", description: "Pay amount in rupees, as a number." },
        wage_type: { type: "string", enum: ["per_day", "per_job"] },
        workers_needed: { type: "integer", description: "How many workers (>= 1)." },
        job_date: {
          type: "string",
          description:
            "Work date as YYYY-MM-DD. Resolve relative words like 'tomorrow', 'நாளை' from today.",
        },
        description: { type: "string", description: "Optional extra detail." },
        village: {
          type: "string",
          description: "Defaults to the user's own village if not stated.",
        },
      },
      required: ["title", "job_type", "wage_amount", "workers_needed", "job_date"],
    },
  },
  {
    name: "search_jobs",
    description:
      "Search open jobs by free-text query (semantic). Returns up to 5 nearby matches with id + title + village + wage.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What kind of work to search for." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_my_jobs",
    description: "List jobs the signed-in user has posted (most recent first, max 10).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_my_applications",
    description:
      "List jobs the signed-in user has shown interest in (max 10). Each item includes the job id, title, employer name, and current status.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "show_interest",
    description:
      "Express interest in a specific job, by its id. Only call after the user confirms.",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string", description: "UUID of the job." } },
      required: ["job_id"],
    },
  },
  {
    name: "update_job",
    description:
      "Edit one or more fields on a job the user owns. Provide ONLY the fields the user wants to change — leave the rest unset. Call AFTER the user confirms the change.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "UUID of the job to update." },
        title: { type: "string" },
        description: { type: "string" },
        village: { type: "string", description: "Free text — e.g. 'West Cheyyur'. Will be transliterated to both scripts." },
        job_type: { type: "string", enum: [...JOB_TYPES] },
        workers_needed: { type: "integer" },
        wage_amount: { type: "number" },
        wage_type: { type: "string", enum: ["per_day", "per_job"] },
        job_date: { type: "string", description: "YYYY-MM-DD." },
      },
      required: ["job_id"],
    },
  },
  {
    name: "cancel_job",
    description:
      "Cancel one of the user's jobs (sets status='cancelled' — the job stays in 'My Jobs' but is removed from the public feed). Confirm with the user FIRST.",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "delete_job",
    description:
      "Permanently delete one of the user's jobs, including all its chats, responses and ratings. Irreversible. Always confirm with a clear warning before calling.",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "complete_job",
    description:
      "Mark a job 'completed' (the work is done). Both sides can rate each other afterwards. Confirm with the user first.",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "reopen_job",
    description:
      "Reopen a previously cancelled / completed job (sets status back to 'open'). Confirm first.",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "get_job_responses",
    description:
      "List workers who have shown interest in a specific job the user owns. Returns each worker's response_id (use with accept_worker / reject_worker), name, village, and current status.",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "accept_worker",
    description:
      "Accept an interested worker — sets the job_response to 'accepted'. After acceptance, the worker can see the employer's phone and vice versa. Confirm first.",
    parameters: {
      type: "object",
      properties: { response_id: { type: "string", description: "UUID from get_job_responses." } },
      required: ["response_id"],
    },
  },
  {
    name: "reject_worker",
    description:
      "Reject an interested worker — sets the job_response to 'rejected'. Confirm first.",
    parameters: {
      type: "object",
      properties: { response_id: { type: "string" } },
      required: ["response_id"],
    },
  },
];

// ─── Handlers ───────────────────────────────────────────────────────────────

const TODAY_ISO = () => new Date().toISOString().slice(0, 10);

async function tool_post_job(ctx: AgentContext, args: any) {
  const title = String(args.title ?? "").trim();
  const job_type = String(args.job_type ?? "");
  const wage = Number(args.wage_amount);
  const wage_type = args.wage_type === "per_job" ? "per_job" : "per_day";
  const workers = Math.max(1, Math.floor(Number(args.workers_needed ?? 1)));
  const job_date = String(args.job_date ?? "");
  const description = String(args.description ?? "").trim();
  const village = String(args.village ?? ctx.village ?? "").trim();

  if (!title) return { error: "Missing title." };
  if (!(JOB_TYPES as readonly string[]).includes(job_type))
    return { error: "Invalid job_type." };
  if (!Number.isFinite(wage) || wage < 0) return { error: "Invalid wage." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(job_date)) return { error: "Invalid date." };
  if (!village) return { error: "Missing village." };

  const mod = await moderateJob(title, description);
  if (mod && !mod.ok) return { error: mod.reason || "Post rejected by moderation." };

  const [t, d, v] = await Promise.all([
    translatePair(title),
    translatePair(description),
    transliteratePair(village),
  ]);

  const r = await pool.query(
    `insert into jobs
       (posted_by, title, description, job_type, workers_needed,
        wage_amount, wage_type, job_date, district, village, pincode, lat, lng,
        title_ta, title_en, description_ta, description_en, village_ta, village_en)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     returning id, title, village, job_date, wage_amount`,
    [
      ctx.userId, title, description, job_type, workers, wage, wage_type, job_date,
      ctx.district, village, ctx.pincode, ctx.lat, ctx.lng,
      t.ta, t.en, d.ta, d.en, v.ta, v.en,
    ],
  );
  const job = r.rows[0]!;
  void embedAndStoreJob(job.id, { title, description, job_type, village });
  notifyNewJobNearby({
    id: job.id, title, village, district: ctx.district,
    posted_by: ctx.userId, lat: ctx.lat, lng: ctx.lng,
  }).catch(() => {});
  return { ok: true, job_id: job.id, title: job.title, village: job.village };
}

async function tool_search_jobs(ctx: AgentContext, args: any) {
  const q = String(args.query ?? "").trim();
  if (!q) return { error: "Missing query." };
  // Simple text search — keeps the agent's loop short even when embeddings
  // aren't populated. Uses ilike across title and description.
  const r = await pool.query(
    `select j.id, j.title, j.village, j.wage_amount, j.wage_type, j.job_date,
            p.full_name as poster_name
     from jobs j join profiles p on p.id = j.posted_by
     where j.status = 'open'
       and j.posted_by <> $2
       and (j.title ilike $1 or j.description ilike $1
            or j.title_ta ilike $1 or j.title_en ilike $1)
     order by j.created_at desc limit 5`,
    [`%${q}%`, ctx.userId],
  );
  return { count: r.rowCount, jobs: r.rows };
}

async function tool_get_my_jobs(ctx: AgentContext) {
  const r = await pool.query(
    `select id, title, status, job_date, wage_amount,
            (select count(*)::int from job_responses where job_id = jobs.id)
              as response_count
     from jobs where posted_by = $1 order by created_at desc limit 10`,
    [ctx.userId],
  );
  return { count: r.rowCount, jobs: r.rows };
}

async function tool_get_my_applications(ctx: AgentContext) {
  const r = await pool.query(
    `select r.id as response_id, r.status, j.id as job_id, j.title,
            j.job_date, j.wage_amount, p.full_name as employer_name
     from job_responses r
     join jobs j on j.id = r.job_id
     join profiles p on p.id = j.posted_by
     where r.worker_id = $1 order by r.created_at desc limit 10`,
    [ctx.userId],
  );
  return { count: r.rowCount, applications: r.rows };
}

async function tool_show_interest(ctx: AgentContext, args: any) {
  const job_id = String(args.job_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(job_id)) return { error: "Invalid job_id." };
  const j = await pool.query<{ posted_by: string; status: string }>(
    `select posted_by, status from jobs where id = $1`,
    [job_id],
  );
  if (!j.rowCount) return { error: "Job not found." };
  if (j.rows[0]!.posted_by === ctx.userId)
    return { error: "You can't apply to your own job." };
  if (j.rows[0]!.status !== "open")
    return { error: "This job is no longer open." };
  await pool.query(
    `insert into job_responses (job_id, worker_id) values ($1, $2)
     on conflict (job_id, worker_id) do nothing`,
    [job_id, ctx.userId],
  );
  return { ok: true };
}

const UUID = /^[0-9a-f-]{36}$/i;

/** Verify the caller owns a job. Returns null on failure. */
async function assertOwnsJob(ctx: AgentContext, jobId: string) {
  if (!UUID.test(jobId)) return null;
  const r = await pool.query(
    `select id, status from jobs where id = $1 and posted_by = $2`,
    [jobId, ctx.userId],
  );
  return r.rowCount ? r.rows[0]! : null;
}

async function tool_update_job(ctx: AgentContext, args: any) {
  const job_id = String(args.job_id ?? "");
  const owns = await assertOwnsJob(ctx, job_id);
  if (!owns) return { error: "That job is not yours, or it doesn't exist." };

  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (typeof args.title === "string" && args.title.trim()) {
    const pair = await translatePair(args.title.trim());
    add("title", args.title.trim());
    add("title_ta", pair.ta);
    add("title_en", pair.en);
  }
  if (typeof args.description === "string") {
    const pair = await translatePair(args.description.trim());
    add("description", args.description.trim());
    add("description_ta", pair.ta);
    add("description_en", pair.en);
  }
  if (typeof args.village === "string" && args.village.trim()) {
    const pair = await transliteratePair(args.village.trim());
    add("village", args.village.trim());
    add("village_ta", pair.ta);
    add("village_en", pair.en);
  }
  if (args.job_type && (JOB_TYPES as readonly string[]).includes(args.job_type))
    add("job_type", args.job_type);
  if (args.workers_needed != null) {
    const n = Math.max(1, Math.floor(Number(args.workers_needed)));
    if (Number.isFinite(n)) add("workers_needed", n);
  }
  if (args.wage_amount != null) {
    const n = Number(args.wage_amount);
    if (Number.isFinite(n) && n >= 0) add("wage_amount", n);
  }
  if (args.wage_type === "per_day" || args.wage_type === "per_job")
    add("wage_type", args.wage_type);
  if (typeof args.job_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.job_date))
    add("job_date", args.job_date);

  if (!sets.length) return { error: "Nothing to update." };
  params.push(job_id);

  const r = await pool.query(
    `update jobs set ${sets.join(", ")} where id = $${params.length} returning id, title, village, status`,
    params,
  );
  return { ok: true, updated: sets.length / 3, job: r.rows[0] };
}

async function tool_set_status(ctx: AgentContext, jobId: string, status: string) {
  const owns = await assertOwnsJob(ctx, jobId);
  if (!owns) return { error: "That job is not yours, or it doesn't exist." };
  await pool.query(`update jobs set status = $1 where id = $2`, [status, jobId]);
  return { ok: true, status };
}

async function tool_delete_job(ctx: AgentContext, args: any) {
  const owns = await assertOwnsJob(ctx, String(args.job_id ?? ""));
  if (!owns) return { error: "That job is not yours, or it doesn't exist." };
  await pool.query(`delete from jobs where id = $1`, [args.job_id]);
  return { ok: true, deleted: true };
}

async function tool_get_job_responses(ctx: AgentContext, args: any) {
  const owns = await assertOwnsJob(ctx, String(args.job_id ?? ""));
  if (!owns) return { error: "That job is not yours, or it doesn't exist." };
  const r = await pool.query(
    `select r.id as response_id, r.status,
            p.full_name as worker_name, p.village as worker_village,
            (select avg(stars)::numeric(3,2) from ratings where ratee_id = p.id) as stars
     from job_responses r join profiles p on p.id = r.worker_id
     where r.job_id = $1 order by r.created_at`,
    [args.job_id],
  );
  return { count: r.rowCount, applicants: r.rows };
}

async function tool_respond_status(
  ctx: AgentContext,
  responseId: string,
  status: "accepted" | "rejected",
) {
  if (!UUID.test(responseId)) return { error: "Invalid response_id." };
  // Owner-of-job-only: re-checks via subquery on the response's job.
  const r = await pool.query(
    `update job_responses set status = $1
     where id = $2 and job_id in (select id from jobs where posted_by = $3)
     returning id, worker_id`,
    [status, responseId, ctx.userId],
  );
  if (!r.rowCount) return { error: "Response not found, or that job isn't yours." };
  return { ok: true, status };
}

export const TOOL_HANDLERS: Record<
  string,
  (ctx: AgentContext, args: any) => Promise<any>
> = {
  post_job: tool_post_job,
  search_jobs: tool_search_jobs,
  get_my_jobs: (ctx) => tool_get_my_jobs(ctx),
  get_my_applications: (ctx) => tool_get_my_applications(ctx),
  show_interest: tool_show_interest,
  update_job: tool_update_job,
  cancel_job: (ctx, args) => tool_set_status(ctx, String(args.job_id ?? ""), "cancelled"),
  complete_job: (ctx, args) => tool_set_status(ctx, String(args.job_id ?? ""), "completed"),
  reopen_job: (ctx, args) => tool_set_status(ctx, String(args.job_id ?? ""), "open"),
  delete_job: tool_delete_job,
  get_job_responses: tool_get_job_responses,
  accept_worker: (ctx, args) => tool_respond_status(ctx, String(args.response_id ?? ""), "accepted"),
  reject_worker: (ctx, args) => tool_respond_status(ctx, String(args.response_id ?? ""), "rejected"),
};

// ─── System prompt ──────────────────────────────────────────────────────────

export function buildSystemPrompt(ctx: AgentContext): string {
  const today = TODAY_ISO();
  const defaultLangHint =
    ctx.lang === "ta"
      ? "If a message is ambiguous about language, default to Tamil."
      : "If a message is ambiguous about language, default to English.";
  return `You are Velai, a voice assistant for a Tamil Nadu rural daily-wage job marketplace.
You are talking with a worker/employer over voice. Your reply will be SPOKEN out loud.

LANGUAGE — CRITICAL
- Detect the language of the user's MOST RECENT message and reply in THAT
  language. You speak Tamil and English fluently — switch freely between
  them as the user does.
- If they write Tamil (Tamil script or transliteration like "naalaikku"),
  reply in Tamil using friendly spoken-plural ('-ங்க' endings, e.g.
  'சொல்லுங்க', 'வாங்க'). Avoid academic / literary words.
- If they write English, reply in plain conversational English.
- ${defaultLangHint}
- NEVER refuse to speak a language. NEVER say "I can only reply in X".

VOICE STYLE
- Keep replies to ONE or TWO short sentences. No lists, no markdown, no emojis.

USER PROFILE
- Name: ${ctx.name}
- Village: ${ctx.village}
- District: ${ctx.district}
- Today's date is ${today}.

ACTIONS YOU CAN TAKE
You have tools (functions) — call one only when it's clearly needed.

POSTING & EDITING JOBS (owner side)
- post_job: collect title, job_type, wage_amount, workers_needed, job_date,
  village (defaults to the user's). If any are missing, ASK in one short
  question — don't guess. Resolve "tomorrow"/"நாளை" to ${today}+1.
- update_job: edit ONE or more fields on an existing job the user owns. Pass
  ONLY the fields they asked to change. Need a job_id — get one from
  get_my_jobs if you don't already have it from this conversation.
- cancel_job / complete_job / reopen_job: change a job's status.
- delete_job: permanently removes the job + its chats + responses. Confirm
  with a CLEAR warning before calling.

MANAGING APPLICANTS (owner side)
- get_job_responses(job_id): list workers who applied to a specific job.
  Use this before accepting/rejecting so you have their response_id.
- accept_worker / reject_worker: pass the response_id from get_job_responses.

WORKER SIDE
- search_jobs: read the top 1-2 results back conversationally — don't dump
  the whole list.
- show_interest(job_id): apply to a job. Confirm first.
- get_my_applications: list what they've applied to.

USING JOB IDS — IMPORTANT
- Never ask the user for a UUID. UUIDs are an internal detail.
- If you just used post_job, the response contains job_id. Re-use it
  silently when the user says "that job" / "this job" / "the one I just
  posted" / "அந்த வேலை".
- If the user refers to "my paddy job" / "the coconut job" / "my second
  job", and you don't have the id in this conversation, call get_my_jobs,
  match by title/job_type/recency, and use that id.
- If multiple jobs could match, READ back the candidates (by title +
  village) and ask which one — never read the id aloud.

CONFIRMATION RULE
Before any tool that CREATES, UPDATES, CANCELS or DELETES anything, say
exactly what you're about to do in one short sentence and wait for the user
to say yes/சரி/ஆமா. Read-only tools (search_jobs, get_my_jobs,
get_my_applications, get_job_responses) don't need confirmation.

WHAT YOU DO NOT DO
- Never invent job ids, wages, or villages. If you don't know, ask or look it up.
- Never refuse to switch languages — speak whichever language the user just used.
- Never read a UUID out loud — refer to jobs by their title and workers by name.`;
}
