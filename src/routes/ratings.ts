/**
 * Two-way ratings.
 *
 *   POST /api/ratings              create a rating (auth)
 *   GET  /api/ratings/user/:id     public: aggregate + recent comments
 *   GET  /api/ratings/can/:jobId   who, if anyone, the caller can rate on this job
 */
import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { isUuid } from "../lib/validate";

const router = Router();

/** Aggregate reputation for any profile — public. */
router.get("/user/:id", optionalAuth, async (req, res) => {
  if (!isUuid(req.params.id)) throw new ApiError(404, "User not found");
  const agg = await pool.query<{ avg: string | null; n: string }>(
    "select avg(stars)::numeric(3,2) as avg, count(*)::text as n from ratings where ratee_id = $1",
    [req.params.id],
  );
  const recent = await pool.query(
    `select r.stars, r.comment, r.created_at, p.full_name as rater_name, j.title as job_title
     from ratings r
     join profiles p on p.id = r.rater_id
     join jobs j on j.id = r.job_id
     where r.ratee_id = $1
     order by r.created_at desc limit 8`,
    [req.params.id],
  );
  res.json({
    avg: agg.rows[0]?.avg ? Number(agg.rows[0].avg) : null,
    count: Number(agg.rows[0]?.n ?? 0),
    recent: recent.rows,
  });
});

/**
 * Tell the frontend whether the caller may rate someone on this job — and who.
 * Returns: { can_rate: bool, ratee_id?, ratee_name?, already_rated: bool }.
 */
router.get("/can/:jobId", requireAuth, async (req, res) => {
  const me = req.auth!.sub;
  if (!isUuid(req.params.jobId)) throw new ApiError(404, "Job not found");

  const jr = await pool.query<{ posted_by: string; status: string }>(
    "select posted_by, status from jobs where id = $1",
    [req.params.jobId],
  );
  if (!jr.rowCount) throw new ApiError(404, "Job not found");
  const job = jr.rows[0]!;
  if (job.status !== "completed") return res.json({ can_rate: false });

  // The "other side" is the employer (if caller is an accepted worker) or
  // the accepted worker (if caller is the employer).
  let ratee: { id: string; full_name: string } | undefined;
  if (job.posted_by === me) {
    const w = await pool.query<{ id: string; full_name: string }>(
      `select p.id, p.full_name
       from job_responses r join profiles p on p.id = r.worker_id
       where r.job_id = $1 and r.status = 'accepted' limit 1`,
      [req.params.jobId],
    );
    ratee = w.rows[0];
  } else {
    const r = await pool.query(
      "select 1 from job_responses where job_id = $1 and worker_id = $2 and status = 'accepted'",
      [req.params.jobId, me],
    );
    if (r.rowCount) {
      const e = await pool.query<{ id: string; full_name: string }>(
        "select id, full_name from profiles where id = (select posted_by from jobs where id = $1)",
        [req.params.jobId],
      );
      ratee = e.rows[0];
    }
  }
  if (!ratee) return res.json({ can_rate: false });

  const already = await pool.query(
    "select 1 from ratings where job_id = $1 and rater_id = $2",
    [req.params.jobId, me],
  );
  res.json({
    can_rate: !already.rowCount,
    already_rated: !!already.rowCount,
    ratee_id: ratee.id,
    ratee_name: ratee.full_name,
  });
});

/** Submit a rating. Body: { job_id, ratee_id, stars, comment? }. */
router.post("/", requireAuth, async (req, res) => {
  const me = req.auth!.sub;
  const { job_id, ratee_id, stars, comment = "" } = req.body ?? {};
  if (!isUuid(job_id) || !isUuid(ratee_id))
    throw new ApiError(400, "Invalid job or user");
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5)
    throw new ApiError(400, "Stars must be between 1 and 5");
  if (ratee_id === me) throw new ApiError(400, "You can't rate yourself");

  // Re-validate eligibility server-side. (The /can endpoint is just a hint.)
  const j = await pool.query<{ posted_by: string; status: string }>(
    "select posted_by, status from jobs where id = $1",
    [job_id],
  );
  if (!j.rowCount) throw new ApiError(404, "Job not found");
  if (j.rows[0]!.status !== "completed")
    throw new ApiError(400, "You can rate after the job is marked completed");

  const callerIsOwner = j.rows[0]!.posted_by === me;
  const callerIsWorker = (
    await pool.query(
      "select 1 from job_responses where job_id = $1 and worker_id = $2 and status = 'accepted'",
      [job_id, me],
    )
  ).rowCount;
  if (!callerIsOwner && !callerIsWorker)
    throw new ApiError(403, "Only the employer or an accepted worker may rate");

  // The ratee must be the other side.
  const rateeIsOwner = j.rows[0]!.posted_by === ratee_id;
  const rateeIsWorker = (
    await pool.query(
      "select 1 from job_responses where job_id = $1 and worker_id = $2 and status = 'accepted'",
      [job_id, ratee_id],
    )
  ).rowCount;
  if (callerIsOwner && !rateeIsWorker)
    throw new ApiError(400, "That worker wasn't accepted on this job");
  if (callerIsWorker && !rateeIsOwner)
    throw new ApiError(400, "You can only rate the employer on this job");

  const ins = await pool.query(
    `insert into ratings (job_id, rater_id, ratee_id, stars, comment)
     values ($1, $2, $3, $4, $5)
     on conflict (job_id, rater_id) do nothing
     returning id, stars, comment, created_at`,
    [job_id, me, ratee_id, n, String(comment).slice(0, 500)],
  );
  if (!ins.rowCount) throw new ApiError(409, "You already rated this job");
  res.status(201).json({ rating: ins.rows[0] });
});

export default router;
