import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { isUuid } from "../lib/validate";
import { JOB_TYPES, DISTANCE_KM_SQL } from "../db/schema";
import { recommendJobs, rankBySimilarity } from "../lib/recommend";
import { embedText, geminiAvailable, moderateJob } from "../lib/gemini";
import { embedAndStoreJob, toVectorLiteral } from "../lib/embeddings";

const router = Router();

// Columns selected for job-list responses.
const JOB_COLS = `j.id, j.title, j.job_type, j.workers_needed, j.wage_amount,
  j.wage_type, j.job_date, j.village, j.district, j.status, j.created_at,
  p.full_name as poster_name,
  (select count(*)::int from job_responses jr where jr.job_id = j.id)
    as response_count`;

/**
 * GET /api/jobs — open jobs. Public: all open jobs, newest first.
 * Logged in: sorted by distance from the user, with ?radius= support.
 */
router.get("/", optionalAuth, async (req, res) => {
  const auth = req.auth;
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
    res.json({ jobs: r.rows });
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
    res.json({ jobs: r.rows });
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
  res.json({ jobs: r.rows });
});

/** GET /api/jobs/mine — jobs the user posted. */
router.get("/mine", requireAuth, async (req, res) => {
  const auth = req.auth!;
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
  res.json({ jobs: r.rows });
});

/**
 * GET /api/jobs/search?q=... — semantic search (pgvector), public.
 * Falls back to plain text search if the AI is unavailable.
 */
router.get("/search", optionalAuth, async (req, res) => {
  const auth = req.auth;
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
    const r = await pool.query(
      `select ${JOB_COLS}, ${distExpr} as distance_km,
              round((1 - (j.embedding <=> $1::vector)) * 100)::int as match_score
       from jobs j join profiles p on p.id = j.posted_by
       where j.status = 'open' and j.embedding is not null
       order by j.embedding <=> $1::vector
       limit 20`,
      params,
    );
    res.json({ jobs: r.rows, mode: "semantic" });
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
  res.json({ jobs: r.rows, mode: "text" });
});

/**
 * GET /api/jobs/recommended — personalised recommendations (login required).
 * Embedding-based; falls back to content-based filtering.
 */
router.get("/recommended", requireAuth, async (req, res) => {
  const auth = req.auth!;
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
        jobs: ranked.map((row) => ({
          ...row.job,
          match_score: Math.round(row.score * 100),
        })),
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
    jobs: ranked.map((row) => ({
      ...row.job,
      match_score: Math.round(row.score * 100),
    })),
    mode: "content",
  });
});

/**
 * GET /api/jobs/:id — full detail (public).
 * The poster's phone and the response list require login.
 */
router.get("/:id", optionalAuth, async (req, res) => {
  const auth = req.auth;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Job not found");

  const jr = await pool.query(
    `select j.*, p.full_name as poster_name, p.phone as poster_phone,
            p.village as poster_village
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
        `select r.id, r.status, r.created_at,
                p.full_name as worker_name, p.phone as worker_phone,
                p.village as worker_village, p.skills as worker_skills
         from job_responses r join profiles p on p.id = r.worker_id
         where r.job_id = $1 order by r.created_at`,
        [req.params.id],
      )
    ).rows;
    for (const r of responses) {
      if (r.status !== "accepted") r.worker_phone = null;
    }
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

  const moderation = await moderateJob(title.trim(), desc);
  if (moderation && !moderation.ok)
    throw new ApiError(
      400,
      moderation.reason || "This job post could not be accepted.",
    );

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
        wage_amount, wage_type, job_date, district, village, pincode, lat, lng)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning *`,
    [
      auth.sub,
      title.trim(),
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
    ],
  );
  const job = r.rows[0];
  delete job.embedding;

  void embedAndStoreJob(job.id, job);

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

export default router;
