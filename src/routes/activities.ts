import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";

const router = Router();

/**
 * GET /api/activities/mine
 * Returns the current user's activity log.
 */
router.get("/mine", requireAuth, async (req, res) => {
  const auth = req.auth!;
  const r = await pool.query(
    `select id, action_type, metadata, created_at
     from user_activities
     where user_id = $1
     order by created_at desc
     limit 50`,
    [auth.sub]
  );
  res.json({ activities: r.rows });
});

/**
 * GET /api/activities/conversations
 * Returns the current user's AI conversation history.
 */
router.get("/conversations", requireAuth, async (req, res) => {
  const auth = req.auth!;
  const r = await pool.query(
    `select id, user_query, ai_response, created_at
     from ai_conversations
     where user_id = $1
     order by created_at desc
     limit 50`,
    [auth.sub]
  );
  res.json({ conversations: r.rows });
});

export default router;
