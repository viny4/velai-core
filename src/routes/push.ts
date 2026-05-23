/**
 * Push subscription endpoints.
 *
 *   GET    /api/push/key         → VAPID public key (for the browser to subscribe)
 *   POST   /api/push/subscribe   → save the PushSubscription for this user
 *   DELETE /api/push/subscribe   → remove it (called on sign-out)
 */
import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";
import { ApiError } from "../lib/errors";

const router = Router();

router.get("/key", (_req, res) => {
  res.json({ key: config.vapidPublic });
});

router.post("/subscribe", requireAuth, async (req, res) => {
  const me = req.auth!.sub;
  const sub = req.body?.subscription;
  const endpoint: string | undefined = sub?.endpoint;
  const p256dh: string | undefined = sub?.keys?.p256dh;
  const auth: string | undefined = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new ApiError(400, "Invalid subscription");

  // Upsert by endpoint so the same browser updating its subscription just
  // replaces the row (and may even switch which user it belongs to).
  await pool.query(
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth)
     values ($1, $2, $3, $4)
     on conflict (endpoint) do update
       set user_id = excluded.user_id,
           p256dh  = excluded.p256dh,
           auth    = excluded.auth`,
    [me, endpoint, p256dh, auth],
  );
  res.json({ ok: true });
});

router.delete("/subscribe", requireAuth, async (req, res) => {
  const endpoint: string | undefined = req.body?.endpoint;
  if (endpoint)
    await pool.query("delete from push_subscriptions where endpoint = $1", [endpoint]);
  res.json({ ok: true });
});

export default router;
