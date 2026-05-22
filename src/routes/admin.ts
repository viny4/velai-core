import { Router } from "express";
import { pool } from "../db/pool";
import { config } from "../config";
import { ApiError } from "../lib/errors";

const router = Router();

/**
 * GET /api/admin/overview — platform metrics for the pilot dashboard.
 * Protected by the admin key.  Header:  X-Admin-Key: <ADMIN_KEY>
 */
router.get("/overview", async (req, res) => {
  if (req.headers["x-admin-key"] !== config.adminKey)
    throw new ApiError(403, "Wrong admin key");

  const profiles = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where role in ('worker','both'))::int as workers,
            count(*) filter (where role in ('employer','both'))::int as employers,
            count(*) filter (where google_sub is not null)::int as google_users,
            count(*) filter (where created_at > now() - interval '7 days')::int as new_7d
     from profiles`,
  );

  const jobs = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where status='open')::int as open,
            count(*) filter (where status='filled')::int as filled,
            count(*) filter (where status='completed')::int as completed,
            count(*) filter (where status='cancelled')::int as cancelled,
            count(*) filter (where created_at > now() - interval '7 days')::int as new_7d
     from jobs`,
  );

  const responses = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where status='accepted')::int as accepted
     from job_responses`,
  );

  const byDistrict = await pool.query(
    `select d.name as district, count(j.id)::int as n
     from jobs j join districts d on d.slug = j.district
     group by d.name order by n desc limit 8`,
  );

  const byType = await pool.query(
    `select job_type, count(*)::int as n from jobs
     group by job_type order by n desc`,
  );

  const j = jobs.rows[0]!;
  const fillRate =
    j.total > 0 ? Math.round(((j.filled + j.completed) / j.total) * 100) : 0;

  res.json({
    profiles: profiles.rows[0],
    jobs: j,
    responses: responses.rows[0],
    fill_rate: fillRate,
    by_district: byDistrict.rows,
    by_type: byType.rows,
  });
});

export default router;
