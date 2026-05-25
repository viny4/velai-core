import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { isUuid } from "../lib/validate";
import { JOB_TYPES, DISTANCE_KM_SQL } from "../db/schema";
import { recommendJobs, rankBySimilarity } from "../lib/recommend";
import { embedText, geminiAvailable, moderateJob } from "../lib/gemini";
import { embedAndStoreJob, toVectorLiteral } from "../lib/embeddings";
import { notifyNewJobNearby } from "../lib/push";
import {
  translatePair,
  transliteratePair,
  pickLang,
  localizeRow,
  type Lang,
} from "../lib/i18n";

const router = Router();

// Columns selected for job-list responses. Bilingual fields (_ta / _en) come
// through so localizeJobRow() can swap the right one in based on the caller's
// Accept-Language header.
const JOB_COLS = `j.id, j.title, j.title_ta, j.title_en,
  j.job_type, j.workers_needed, j.wage_amount,
  j.wage_type, j.job_date,
  j.village, j.village_ta, j.village_en,
  j.district, j.status, j.created_at,
  p.full_name as poster_name,
  p.full_name_ta as poster_name_ta,
  p.full_name_en as poster_name_en,
  (select count(*)::int from job_responses jr where jr.job_id = j.id)
    as response_count`;

/** Fields on a job row that exist in both Tamil and English. */
const JOB_BASES = ["title", "description", "village", "poster_name", "worker_name"] as const;

/** Replace title/description/village/poster_name with the right language version,
 *  then strip the _ta / _en helpers so the response stays small. */
function localizeJobRow<T extends Record<string, any>>(row: T, lang: Lang): T {
  localizeRow(row, lang, JOB_BASES);
  for (const b of JOB_BASES) {
    delete (row as any)[`${b}_ta`];
    delete (row as any)[`${b}_en`];
  }
  return row;
}

/**
 * GET /api/jobs — open jobs. Public: all open jobs, newest first.
 * Logged in: sorted by distance from the user, with ?radius= support.
 */
router.get("/", optionalAuth, async (req, res) => {
  const auth = req.auth;
  const lang = pickLang(req);
  const jobType = req.query.job_type ? String(req.query.job_type) : null;

  // --- Guest: all open jobs, newest first ---
  if (!auth) {
    const params: unknown[] = [];
    let typeFilter = "";
    if (jobType) {
      params.push(jobType);
      typeFilter = `and j.job_type = $${params.length}`;
    }
    const r = await pool.query(
      `select ${JOB_COLS}, null::float8 as distance_km
       from jobs j join profiles p on p.id = j.posted_by
       where j.status = 'open' ${typeFilter}
       order by j.created_at desc`,
      params,
    );
    res.json({ jobs: r.rows.map((row) => localizeJobRow(row, lang)) });
    return;
  }

  // --- Logged in: personalised by location ---
  const me = await pool.query<{ lat: number | null; lng: number | null }>(
    `select lat, lng from profiles where id = $1`,
    [auth.sub],
  );
  const lat = me.rows[0]?.lat ?? null;
  const lng = me.rows[0]?.lng ?? null;
  const radiusRaw = req.query.radius ? Number(req.query.radius) : null;
  const radius = radiusRaw && radiusRaw > 0 ? radiusRaw : null;

  if (lat == null || lng == null) {
    const params: unknown[] = [auth.district];
    let typeFilter = "";
    if (jobType) {
      params.push(jobType);
      typeFilter = `and j.job_type = $${params.length}`;
    }
    const r = await pool.query(
      `select ${JOB_COLS}, null::float8 as distance_km
       from jobs j join profiles p on p.id = j.posted_by
       where j.status = 'open' and j.district = $1 ${typeFilter}
       order by j.created_at desc`,
      params,
    );
    res.json({ jobs: r.rows.map((row) => localizeJobRow(row, lang)) });
    return;
  }

  const params: unknown[] = [lat, lng];
  const dist = DISTANCE_KM_SQL.replace(/\$LAT/g, "$1").replace(/\$LNG/g, "$2");
  let typeFilter = "";
  if (jobType) {
    params.push(jobType);
    typeFilter = `and j.job_type = $${params.length}`;
  }
  let radiusClause = "true";
  if (radius != null) {
    params.push(radius);
    radiusClause = `(distance_km is null or distance_km <= $${params.length})`;
  }
  const r = await pool.query(
    `select * from (
       select ${JOB_COLS}, ${dist} as distance_km
       from jobs j join profiles p on p.id = j.posted_by
       where j.status = 'open' ${typeFilter}
     ) q
     where ${radiusClause}
     order by distance_km asc nulls last, created_at desc`,
    params,
  );
  res.json({ jobs: r.rows.map((row) => localizeJobRow(row, lang)) });
});

/** GET /api/jobs/mine — jobs the user posted. */
router.get("/mine", requireAuth, async (req, res) => {
  const auth = req.auth!;
  const lang = pickLang(req);
  const r = await pool.query(
    `select j.*,
            (select count(*)::int from job_responses jr
               where jr.job_id = j.id) as response_count
     from jobs j
     where j.posted_by = $1
     order by j.created_at desc`,
    [auth.sub],
  );
  for (const row of r.rows) delete row.embedding;
  res.json({ jobs: r.rows.map((row) => localizeJobRow(row, lang)) });
});

/**
 * GET /api/jobs/search?q=... — semantic search (pgvector), public.
 * Falls back to plain text search if the AI is unavailable.
 */
router.get("/search", optionalAuth, async (req, res) => {
  const auth = req.auth;
  const lang = pickLang(req);
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.json({ jobs: [], mode: "empty" });
    return;
  }

  let lat: number | null = null;
  let lng: number | null = null;
  if (auth) {
    const me = await pool.query<{ lat: number | null; lng: number | null }>(
      `select lat, lng from profiles where id = $1`,
      [auth.sub],
    );
    lat = me.rows[0]?.lat ?? null;
    lng = me.rows[0]?.lng ?? null;
  }
  const hasLoc = lat != null && lng != null;

  const queryVec = await embedText(q);

  if (queryVec) {
    const distExpr = hasLoc
      ? DISTANCE_KM_SQL.replace(/\$LAT/g, "$2").replace(/\$LNG/g, "$3")
      : "null::float8";
    const params: unknown[] = hasLoc
      ? [toVectorLiteral(queryVec), lat, lng]
      : [toVectorLiteral(queryVec)];
    // SIMILARITY_FLOOR drops weak nearest-neighbour matches. Without it,
    // searching "painting" against a DB with no painting jobs would still
    // return the closest jobs (cattle, coconut, etc.) at 40-50% similarity,
    // which is confusing. 0.60 = "the embedding actually has some signal".
    const SIMILARITY_FLOOR = 0.6;
    const r = await pool.query(
      `select ${JOB_COLS}, ${distExpr} as distance_km,
              round((1 - (j.embedding <=> $1::vector)) * 100)::int as match_score
       from jobs j join profiles p on p.id = j.posted_by
       where j.status = 'open' and j.embedding is not null
         and (1 - (j.embedding <=> $1::vector)) >= ${SIMILARITY_FLOOR}
       order by j.embedding <=> $1::vector
       limit 20`,
      params,
    );
    res.json({ jobs: r.rows.map((row) => localizeJobRow(row, lang)), mode: "semantic" });
    return;
  }

  const r = await pool.query(
    `select ${JOB_COLS}, null::float8 as distance_km
     from jobs j join profiles p on p.id = j.posted_by
     where j.status = 'open'
       and (j.title ilike $1 or j.description ilike $1)
     order by j.created_at desc
     limit 20`,
    [`%${q}%`],
  );
  res.json({ jobs: r.rows.map((row) => localizeJobRow(row, lang)), mode: "text" });
});

/**
 * GET /api/jobs/recommended — personalised recommendations (login required).
 * Embedding-based; falls back to content-based filtering.
 */
router.get("/recommended", requireAuth, async (req, res) => {
  const auth = req.auth!;
  const lang = pickLang(req);
  const me = await pool.query<{ lat: number | null; lng: number | null }>(
    `select lat, lng from profiles where id = $1`,
    [auth.sub],
  );
  const lat = me.rows[0]?.lat ?? null;
  const lng = me.rows[0]?.lng ?? null;
  const hasLoc = lat != null && lng != null;

  const history = await pool.query<{ job_id: string; job_type: string }>(
    `select r.job_id, j.job_type
     from job_responses r join jobs j on j.id = r.job_id
     where r.worker_id = $1`,
    [auth.sub],
  );
  const historyJobIds = history.rows.map((row) => row.job_id);
  const historyTypes = history.rows.map((row) => row.job_type);

  if (geminiAvailable() && historyJobIds.length > 0) {
    const distExpr = hasLoc
      ? DISTANCE_KM_SQL.replace(/\$LAT/g, "$3").replace(/\$LNG/g, "$4")
      : "null::float8";
    const params: unknown[] = hasLoc
      ? [historyJobIds, auth.sub, lat, lng]
      : [historyJobIds, auth.sub];
    const r = await pool.query(
      `with profile as (
         select avg(embedding) as taste
         from jobs where id = any($1) and embedding is not null
       )
       select ${JOB_COLS}, ${distExpr} as distance_km,
              1 - (j.embedding <=> profile.taste) as similarity
       from jobs j join profiles p on p.id = j.posted_by, profile
       where j.status = 'open' and j.posted_by <> $2
         and j.embedding is not null and profile.taste is not null`,
      params,
    );
    if (r.rowCount) {
      const ranked = rankBySimilarity(r.rows as any[]).slice(0, 8);
      res.json({
        jobs: ranked.map((row) =>
          localizeJobRow(
            { ...row.job, match_score: Math.round(row.score * 100) },
            lang,
          ),
        ),
        mode: "embedding",
      });
      return;
    }
  }

  const distExpr = hasLoc
    ? DISTANCE_KM_SQL.replace(/\$LAT/g, "$2").replace(/\$LNG/g, "$3")
    : "null::float8";
  const params: unknown[] = hasLoc ? [auth.sub, lat, lng] : [auth.sub];
  const candidates = await pool.query(
    `select ${JOB_COLS}, ${distExpr} as distance_km
     from jobs j join profiles p on p.id = j.posted_by
     where j.status = 'open' and j.posted_by <> $1`,
    params,
  );
  const ranked = recommendJobs(candidates.rows as any[], historyTypes).slice(
    0,
    8,
  );
  res.json({
    jobs: ranked.map((row) =>
      localizeJobRow(
        { ...row.job, match_score: Math.round(row.score * 100) },
        lang,
      ),
    ),
    mode: "content",
  });
});

/**
 * GET /api/jobs/:id — full detail (public).
 * The poster's phone and the response list require login.
 */
router.get("/:id", optionalAuth, async (req, res) => {
  const auth = req.auth;
  const lang = pickLang(req);
  if (!isUuid(req.params.id)) throw new ApiError(404, "Job not found");

  const jr = await pool.query(
    `select j.*,
            p.full_name as poster_name,
            p.full_name_ta as poster_name_ta,
            p.full_name_en as poster_name_en,
            p.phone as poster_phone,
            p.village as poster_village,
            p.village_ta as poster_village_ta,
            p.village_en as poster_village_en,
            (select avg(stars)::numeric(3,2) from ratings where ratee_id = p.id) as poster_avg,
            (select count(*) from ratings where ratee_id = p.id) as poster_rating_count
     from jobs j join profiles p on p.id = j.posted_by
     where j.id = $1`,
    [req.params.id],
  );
  if (!jr.rowCount) throw new ApiError(404, "Job not found");
  const job = jr.rows[0]!;
  delete job.embedding;

  const isOwner = !!auth && job.posted_by === auth.sub;

  // The worker's own response to this job (if any).
  let my_response = null;
  if (auth && !isOwner) {
    const mine = await pool.query(
      `select id, status from job_responses
       where job_id = $1 and worker_id = $2`,
      [req.params.id, auth.sub],
    );
    my_response = mine.rows[0] ?? null;
  }

  // Phone numbers are private. A worker sees the employer's number only
  // after the employer has ACCEPTED their request.
  if (!isOwner && my_response?.status !== "accepted")
    delete job.poster_phone;

  // The owner sees who responded — but a worker's phone only once accepted.
  let responses: any[] = [];
  if (isOwner) {
    responses = (
      await pool.query(
        `select r.id, r.worker_id, r.status, r.created_at,
                p.full_name as worker_name,
                p.full_name_ta as worker_name_ta,
                p.full_name_en as worker_name_en,
                p.phone as worker_phone,
                p.village as worker_village,
                p.village_ta as worker_village_ta,
                p.village_en as worker_village_en,
                p.skills as worker_skills,
                (select avg(stars)::numeric(3,2) from ratings where ratee_id = p.id) as worker_avg,
                (select count(*) from ratings where ratee_id = p.id) as worker_rating_count
         from job_responses r join profiles p on p.id = r.worker_id
         where r.job_id = $1 order by r.created_at`,
        [req.params.id],
      )
    ).rows;
    for (const r of responses) {
      if (r.status !== "accepted") r.worker_phone = null;
      // Localize worker_name + worker_village to the caller's language.
      localizeRow(r, lang, ["worker_name", "worker_village"]);
      delete r.worker_name_ta; delete r.worker_name_en;
      delete r.worker_village_ta; delete r.worker_village_en;
    }
  }

  // Localize the job + poster fields to the caller's language.
  localizeRow(job, lang, ["title", "description", "village", "poster_name", "poster_village"]);
  for (const f of ["title", "description", "village", "poster_name", "poster_village"]) {
    delete job[`${f}_ta`]; delete job[`${f}_en`];
  }

  res.json({ job, is_owner: isOwner, my_response, responses });
});

/** POST /api/jobs — post a job (AI-moderated; embedded for search). */
router.post("/", requireAuth, async (req, res) => {
  const auth = req.auth!;
  const {
    title,
    description,
    job_type,
    workers_needed,
    wage_amount,
    wage_type,
    job_date,
    village,
  } = req.body ?? {};

  if (typeof title !== "string" || !title.trim())
    throw new ApiError(400, "Please enter a job title");
  if (!(JOB_TYPES as readonly string[]).includes(job_type))
    throw new ApiError(400, "Please choose a valid job type");
  const workers = Number(workers_needed ?? 1);
  if (!Number.isInteger(workers) || workers < 1)
    throw new ApiError(400, "Workers needed must be at least 1");
  const wage = Number(wage_amount);
  if (!Number.isFinite(wage) || wage < 0)
    throw new ApiError(400, "Please enter a valid wage amount");
  const wType = wage_type === "per_job" ? "per_job" : "per_day";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(job_date ?? "")))
    throw new ApiError(400, "Please choose the job date");
  if (typeof village !== "string" || !village.trim())
    throw new ApiError(400, "Please enter the village");

  const desc = String(description ?? "").trim();
  const cleanTitle = title.trim();

  const moderation = await moderateJob(cleanTitle, desc);
  if (moderation && !moderation.ok)
    throw new ApiError(
      400,
      moderation.reason || "This job post could not be accepted.",
    );

  // Translate to both languages so the feed renders in whichever the viewer
  // has toggled on. Village is transliterated (preserve the sound). Runs in
  // parallel to keep the insert fast.
  const [titlePair, descPair, villagePair] = await Promise.all([
    translatePair(cleanTitle),
    translatePair(desc),
    transliteratePair(village.trim()),
  ]);

  const loc = await pool.query<{
    district: string;
    pincode: string | null;
    lat: number | null;
    lng: number | null;
  }>(`select district, pincode, lat, lng from profiles where id = $1`, [
    auth.sub,
  ]);
  if (!loc.rowCount) throw new ApiError(404, "Profile not found");
  const p = loc.rows[0]!;

  const r = await pool.query(
    `insert into jobs
       (posted_by, title, description, job_type, workers_needed,
        wage_amount, wage_type, job_date, district, village, pincode, lat, lng,
        title_ta, title_en, description_ta, description_en,
        village_ta, village_en)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     returning *`,
    [
      auth.sub,
      cleanTitle,
      desc,
      job_type,
      workers,
      wage,
      wType,
      job_date,
      p.district,
      village.trim(),
      p.pincode,
      p.lat,
      p.lng,
      titlePair.ta,
      titlePair.en,
      descPair.ta,
      descPair.en,
      villagePair.ta,
      villagePair.en,
    ],
  );
  const job = r.rows[0];
  delete job.embedding;

  void embedAndStoreJob(job.id, job);
  notifyNewJobNearby(job).catch(() => {
    /* alerting failures must not break job posting */
  });

  res.status(201).json({ job });
});

/** POST /api/jobs/:id/interest — a worker shows interest in a job. */
router.post("/:id/interest", requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Job not found");

  const j = await pool.query(
    `select posted_by, status from jobs where id = $1`,
    [req.params.id],
  );
  if (!j.rowCount) throw new ApiError(404, "Job not found");
  if (j.rows[0]!.posted_by === auth.sub)
    throw new ApiError(400, "You cannot respond to your own job");
  if (j.rows[0]!.status !== "open")
    throw new ApiError(400, "This job is no longer open");

  const r = await pool.query(
    `insert into job_responses (job_id, worker_id)
     values ($1, $2)
     on conflict (job_id, worker_id) do nothing
     returning id, status`,
    [req.params.id, auth.sub],
  );
  if (!r.rowCount)
    throw new ApiError(409, "You have already shown interest in this job");
  res.status(201).json({ response: r.rows[0] });
});

/** PATCH /api/jobs/:id/status — owner marks a job filled / completed / etc. */
router.patch("/:id/status", requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Job not found");
  const status = req.body?.status;
  if (!["open", "filled", "completed", "cancelled"].includes(status))
    throw new ApiError(400, "Invalid status");

  const r = await pool.query(
    `update jobs set status = $1 where id = $2 and posted_by = $3 returning *`,
    [status, req.params.id, auth.sub],
  );
  if (!r.rowCount) throw new ApiError(404, "Job not found or not yours");
  const job = r.rows[0];
  delete job.embedding;
  res.json({ job });
});

/**
 * PATCH /api/jobs/:id — owner partial update.
 * Updatable fields: title, description, job_type, workers_needed,
 * wage_amount, wage_type, job_date, village. Status changes use
 * /api/jobs/:id/status. Text fields are auto-re-translated (TA ↔ EN); the
 * embedding is refreshed when title or description changes.
 */
router.patch("/:id", requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Job not found");

  // Ownership check before doing any work.
  const owned = await pool.query<{ id: string }>(
    `select id from jobs where id = $1 and posted_by = $2`,
    [req.params.id, auth.sub],
  );
  if (!owned.rowCount) throw new ApiError(404, "Job not found or not yours");

  const b = req.body ?? {};
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (typeof b.title === "string" && b.title.trim()) {
    const t = b.title.trim();
    const pair = await translatePair(t);
    add("title", t);
    add("title_ta", pair.ta);
    add("title_en", pair.en);
  }
  if (typeof b.description === "string") {
    const d = b.description.trim();
    const pair = await translatePair(d);
    add("description", d);
    add("description_ta", pair.ta);
    add("description_en", pair.en);
  }
  if (typeof b.village === "string" && b.village.trim()) {
    const v = b.village.trim();
    const pair = await transliteratePair(v);
    add("village", v);
    add("village_ta", pair.ta);
    add("village_en", pair.en);
  }
  if (b.job_type && (JOB_TYPES as readonly string[]).includes(b.job_type))
    add("job_type", b.job_type);
  if (b.workers_needed != null) {
    const n = Math.max(1, Math.floor(Number(b.workers_needed)));
    if (Number.isFinite(n)) add("workers_needed", n);
  }
  if (b.wage_amount != null) {
    const n = Number(b.wage_amount);
    if (Number.isFinite(n) && n >= 0) add("wage_amount", n);
  }
  if (b.wage_type === "per_day" || b.wage_type === "per_job")
    add("wage_type", b.wage_type);
  if (typeof b.job_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.job_date))
    add("job_date", b.job_date);

  if (!sets.length) throw new ApiError(400, "Nothing to update");
  params.push(req.params.id);

  const r = await pool.query(
    `update jobs set ${sets.join(", ")} where id = $${params.length} returning *`,
    params,
  );
  const job = r.rows[0]!;

  // Refresh the embedding only when the text Gemini sees has actually changed.
  if (b.title !== undefined || b.description !== undefined || b.job_type !== undefined)
    void embedAndStoreJob(job.id, job);

  delete job.embedding;
  res.json({ job });
});

/** DELETE /api/jobs/:id — owner deletes a job (cascades chats, responses, ratings). */
router.delete("/:id", requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Job not found");
  const r = await pool.query(
    `delete from jobs where id = $1 and posted_by = $2 returning id`,
    [req.params.id, auth.sub],
  );
  if (!r.rowCount) throw new ApiError(404, "Job not found or not yours");
  res.json({ ok: true });
});

export default router;
