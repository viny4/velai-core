/**
 * In-app pilot feedback. Anyone can submit — anonymous is fine. The admin
 * route lists it back. Used during the village rollout to capture "this
 * confused me" / "this didn't work" reports without leaving the app.
 *
 *   POST /api/feedback         optionalAuth — body: { body, page? }
 *   GET  /api/feedback/recent  adminKey-protected — last 100 entries
 */
import { Router } from "express";
import { pool } from "../db/pool";
import { optionalAuth } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { config } from "../config";

const router = Router();

router.post("/", optionalAuth, async (req, res) => {
  const body = String(req.body?.body ?? "").trim().slice(0, 2000);
  const page = String(req.body?.page ?? "").slice(0, 200);
  if (!body) throw new ApiError(400, "Please tell us what to fix");
  await pool.query(
    "insert into feedback (user_id, body, page) values ($1, $2, $3)",
    [req.auth?.sub ?? null, body, page],
  );
  res.json({ ok: true });
});

router.get("/recent", async (req, res) => {
  if (req.headers["x-admin-key"] !== config.adminKey)
    throw new ApiError(401, "Admin only");
  const r = await pool.query(
    `select f.id, f.body, f.page, f.created_at,
            p.full_name as user_name, p.phone as user_phone
     from feedback f left join profiles p on p.id = f.user_id
     order by f.created_at desc limit 100`,
  );
  res.json({ feedback: r.rows });
});

export default router;
