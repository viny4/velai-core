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
          description: "The category that best fits the work.",
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

export const TOOL_HANDLERS: Record<
  string,
  (ctx: AgentContext, args: any) => Promise<any>
> = {
  post_job: tool_post_job,
  search_jobs: tool_search_jobs,
  get_my_jobs: (ctx) => tool_get_my_jobs(ctx),
  get_my_applications: (ctx) => tool_get_my_applications(ctx),
  show_interest: tool_show_interest,
};

// ─── System prompt ──────────────────────────────────────────────────────────

export function buildSystemPrompt(ctx: AgentContext): string {
  const today = TODAY_ISO();
  const langLine =
    ctx.lang === "ta"
      ? "Reply in Tamil using friendly spoken-plural ('-ங்க' endings, like 'சொல்லுங்க'). Avoid academic words."
      : "Reply in plain conversational English.";
  return `You are Velai, a voice assistant for a Tamil Nadu rural daily-wage job marketplace.
You are talking with a worker/employer over voice. Your reply will be SPOKEN out loud.

VOICE STYLE
- Keep replies to ONE or TWO short sentences. No lists, no markdown, no emojis.
- ${langLine}

USER PROFILE
- Name: ${ctx.name}
- Village: ${ctx.village}
- District: ${ctx.district}
- Today's date is ${today}.

ACTIONS YOU CAN TAKE
You have tools (functions) — call one only when it's clearly needed.
- To POST a job: collect title, job_type, wage_amount, workers_needed, job_date,
  village (defaults to the user's). If any are missing, ASK in one short
  question — don't guess. Resolve "tomorrow"/"நாளை" to ${today}+1.
- ALWAYS confirm with the user ("Should I post it?" / "வெளியிடவா?") before
  calling post_job. Only call after they say yes.
- For search: call search_jobs and READ the top 1-2 results back. Don't dump
  all 5 — keep it conversational. Mention the job_id only if the user wants
  more detail (you'll need it for show_interest).
- show_interest is destructive — confirm first.
- For "what jobs have I posted / applied to": call get_my_jobs or
  get_my_applications and summarise the count + the most recent one.

WHAT YOU DO NOT DO
- Never invent job ids, wages, or villages. If you don't know, ask.
- Never reply in a language different from the user's last message.
- Never read a UUID out loud — refer to jobs by their title.`;
}
