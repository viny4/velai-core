import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { isUuid } from "../lib/validate";
import { JOB_TYPES, DISTANCE_KM_SQL } from "../db/schema";
import { recommendJobs } from "../lib/recommend";

const router = Router();
router.use(requireAuth);

/**
 * GET /api/jobs — open jobs near the user, sorted by distance.
 * Query params: ?job_type=<type>  ?radius=<km>
 * Falls back to the user's home district if their profile has no coordinates.
 */
router.get("/", async (req, res) => {
  const auth = req.auth!;
  const me = await pool.query<{ lat: number | null; lng: number | null }>(
    `select lat, lng from profiles where id = $1`,
    [auth.sub],
  );
  const lat = me.rows[0]?.lat ?? null;
  const lng = me.rows[0]?.lng ?? null;
  const jobType = req.query.job_type ? String(req.query.job_type) : null;
  const radiusRaw = req.query.radius ? Number(req.query.radius) : null;
  const radius = radiusRaw && radiusRaw > 0 ? radiusRaw : null;

  // No coordinates → fall back to the user's home district, newest first.
  if (lat == null || lng == null) {
    const params: unknown[] = [auth.district];
    let typeFilter = "";
    if (jobType) {
      params.push(jobType);
      typeFilter = `and j.job_type = $${params.length}`;
    }
    const r = await pool.query(
      `select j.id, j.title, j.job_type, j.workers_needed, j.wage_amount,
              j.wage_type, j.job_date, j.village, j.district, j.status, j.created_at,
              p.full_name as poster_name,
              (select count(*)::int from job_responses jr
                 where jr.job_id = j.id) as response_count,
              null::float8 as distance_km
       from jobs j join profiles p on p.id = j.posted_by
       where j.status = 'open' and j.district = $1 ${typeFilter}
       order by j.created_at desc`,
      params,
    );
    res.json({ jobs: r.rows });
    return;
  }

  const params: unknown[] = [lat, lng]; // $1 = lat, $2 = lng
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
       select j.id, j.title, j.job_type, j.workers_needed, j.wage_amount,
              j.wage_type, j.job_date, j.village, j.district, j.status, j.created_at,
              p.full_name as poster_name,
              (select count(*)::int from job_responses jr
                 where jr.job_id = j.id) as response_count,
              ${dist} as distance_km
       from jobs j join profiles p on p.id = j.posted_by
       where j.status = 'open' ${typeFilter}
     ) q
     where ${radiusClause}
     order by distance_km asc nulls last, created_at desc`,
    params,
  );
  res.json({ jobs: r.rows });
});

/** GET /api/jobs/mine — jobs the user posted. Defined before /:id on purpose. */
router.get("/mine", async (req, res) => {
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
  res.json({ jobs: r.rows });
});

/**
 * GET /api/jobs/recommended — personalised recommendations (content-based
 * filtering). Ranks open jobs by cosine similarity to the worker's interest
 * history, blended with proximity and recency. Before /:id on purpose.
 */
router.get("/recommended", async (req, res) => {
  const auth = req.auth!;

  const me = await pool.query<{ lat: number | null; lng: number | null }>(
    `select lat, lng from profiles where id = $1`,
    [auth.sub],
  );
  const lat = me.rows[0]?.lat ?? null;
  const lng = me.rows[0]?.lng ?? null;

  // The worker's interaction history → job types they have engaged with.
  const history = await pool.query<{ job_type: string }>(
    `select j.job_type
     from job_responses r
     join jobs j on j.id = r.job_id
     where r.worker_id = $1`,
    [auth.sub],
  );
  const historyTypes = history.rows.map((row) => row.job_type);

  // Candidate jobs: open jobs the worker did not post, with distance.
  const hasLoc = lat != null && lng != null;
  const params: unknown[] = hasLoc ? [auth.sub, lat, lng] : [auth.sub];
  const distExpr = hasLoc
    ? DISTANCE_KM_SQL.replace(/\$LAT/g, "$2").replace(/\$LNG/g, "$3")
    : "null::float8";
  const candidates = await pool.query(
    `select j.id, j.title, j.job_type, j.workers_needed, j.wage_amount,
            j.wage_type, j.job_date, j.village, j.district, j.status, j.created_at,
            p.full_name as poster_name,
            (select count(*)::int from job_responses jr
               where jr.job_id = j.id) as response_count,
            ${distExpr} as distance_km
     from jobs j join profiles p on p.id = j.posted_by
     where j.status = 'open' and j.posted_by <> $1`,
    params,
  );

  const ranked = recommendJobs(candidates.rows, historyTypes).slice(0, 8);
  res.json({
    jobs: ranked.map((row) => ({
      ...row.job,
      match_score: Math.round(row.score * 100),
    })),
  });
});

/** GET /api/jobs/:id — full detail. Responses are visible only to the owner. */
router.get("/:id", async (req, res) => {
  const auth = req.auth!;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Job not found");

  const jr = await pool.query(
    `select j.*, p.full_name as poster_name, p.phone as poster_phone,
            p.village as poster_village
     from jobs j
     join profiles p on p.id = j.posted_by
     where j.id = $1`,
    [req.params.id],
  );
  if (!jr.rowCount) throw new ApiError(404, "Job not found");
  const job = jr.rows[0]!;
  const isOwner = job.posted_by === auth.sub;

  const responses = isOwner
    ? (
        await pool.query(
          `select r.id, r.status, r.created_at,
                  p.full_name as worker_name, p.phone as worker_phone,
                  p.village as worker_village, p.skills as worker_skills
           from job_responses r
           join profiles p on p.id = r.worker_id
           where r.job_id = $1
           order by r.created_at`,
          [req.params.id],
        )
      ).rows
    : [];

  const mine = await pool.query(
    `select id, status from job_responses where job_id = $1 and worker_id = $2`,
    [req.params.id, auth.sub],
  );

  res.json({
    job,
    is_owner: isOwner,
    my_response: mine.rows[0] ?? null,
    responses,
  });
});

/** POST /api/jobs — post a job; it inherits the poster's location. */
router.post("/", async (req, res) => {
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

  const me = await pool.query<{
    district: string;
    pincode: string | null;
    lat: number | null;
    lng: number | null;
  }>(`select district, pincode, lat, lng from profiles where id = $1`, [
    auth.sub,
  ]);
  if (!me.rowCount) throw new ApiError(404, "Profile not found");
  const loc = me.rows[0]!;

  const r = await pool.query(
    `insert into jobs
       (posted_by, title, description, job_type, workers_needed,
        wage_amount, wage_type, job_date, district, village, pincode, lat, lng)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning *`,
    [
      auth.sub,
      title.trim(),
      String(description ?? "").trim(),
      job_type,
      workers,
      wage,
      wType,
      job_date,
      loc.district,
      village.trim(),
      loc.pincode,
      loc.lat,
      loc.lng,
    ],
  );
  res.status(201).json({ job: r.rows[0] });
});

/** POST /api/jobs/:id/interest — a worker shows interest in a job. */
router.post("/:id/interest", async (req, res) => {
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
router.patch("/:id/status", async (req, res) => {
  const auth = req.auth!;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Job not found");
  const status = req.body?.status;
  if (!["open", "filled", "completed", "cancelled"].includes(status))
    throw new ApiError(400, "Invalid status");

  const r = await pool.query(
    `update jobs set status = $1
     where id = $2 and posted_by = $3
     returning *`,
    [status, req.params.id, auth.sub],
  );
  if (!r.rowCount) throw new ApiError(404, "Job not found or not yours");
  res.json({ job: r.rows[0] });
});

export default router;
