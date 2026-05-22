import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { isUuid } from "../lib/validate";

const router = Router();
router.use(requireAuth);

/** GET /api/responses/mine — jobs the current worker has shown interest in. */
router.get("/mine", async (req, res) => {
  const auth = req.auth!;
  const r = await pool.query(
    `select r.id, r.status, r.created_at,
            j.id as job_id, j.title, j.job_type, j.wage_amount, j.wage_type,
            j.job_date, j.village, j.status as job_status,
            p.full_name as poster_name, p.phone as poster_phone
     from job_responses r
     join jobs j on j.id = r.job_id
     join profiles p on p.id = j.posted_by
     where r.worker_id = $1
     order by r.created_at desc`,
    [auth.sub],
  );
  // The employer's phone is shared only once the worker is accepted.
  for (const row of r.rows) {
    if (row.status !== "accepted") row.poster_phone = null;
  }
  res.json({ responses: r.rows });
});

/** PATCH /api/responses/:id — employer accepts / rejects a worker.
 *  The update only touches responses on jobs the caller owns. */
router.patch("/:id", async (req, res) => {
  const auth = req.auth!;
  if (!isUuid(req.params.id)) throw new ApiError(404, "Response not found");
  const status = req.body?.status;
  if (!["accepted", "rejected", "interested"].includes(status))
    throw new ApiError(400, "Invalid status");

  const r = await pool.query(
    `update job_responses set status = $1
     where id = $2
       and job_id in (select id from jobs where posted_by = $3)
     returning id, status, job_id`,
    [status, req.params.id, auth.sub],
  );
  if (!r.rowCount) throw new ApiError(404, "Response not found or not your job");
  res.json({ response: r.rows[0] });
});

export default router;
