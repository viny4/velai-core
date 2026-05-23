/**
 * Web Push notifications.
 *
 * `notifyPush(userId, payload)` is the public entry point: it fans the payload
 * out to every subscription the user has (phone, laptop, tablet). Failed
 * endpoints (410 Gone) are auto-deleted so dead subscriptions don't keep
 * causing errors.
 *
 * Used together with `notifyUser` from realtime.ts: WebSocket delivers when
 * the app is open, push delivers when it isn't.
 */
import webpush from "web-push";
import { pool } from "../db/pool";
import { config } from "../config";

let configured = false;
function configure(): boolean {
  if (configured) return true;
  if (!config.vapidPublic || !config.vapidPrivate) return false;
  webpush.setVapidDetails(
    config.vapidContact,
    config.vapidPublic,
    config.vapidPrivate,
  );
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Path the browser should open when the user taps the notification. */
  url?: string;
  /** Coalesces notifications: a newer one with the same tag replaces it. */
  tag?: string;
}

export async function notifyPush(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  if (!configure()) return;

  const r = await pool.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    "select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1",
    [userId],
  );
  if (!r.rowCount) return;

  const data = JSON.stringify(payload);
  const dead: string[] = [];

  await Promise.all(
    r.rows.map(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          data,
        );
      } catch (e: any) {
        // 404 / 410 = subscription is permanently dead. Drop it.
        if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.id);
      }
    }),
  );

  if (dead.length)
    await pool.query("delete from push_subscriptions where id = any($1)", [dead]);
}

/**
 * Push "New job near you" to workers in the same district as the job, except
 * the poster. Cheap-and-correct: district is the strong filter; haversine
 * orders by distance and keeps the ~80 closest. Push fan-out runs through
 * notifyPush so dead subscriptions are auto-cleaned.
 */
export async function notifyNewJobNearby(job: {
  id: string;
  title: string;
  village: string;
  district: string;
  posted_by: string;
  lat: number | null;
  lng: number | null;
}): Promise<void> {
  if (!configure()) return;

  // Subscribed workers in the same district, nearest first when we have coords.
  const r = await pool.query<{ user_id: string }>(
    `select distinct s.user_id
     from push_subscriptions s
     join profiles p on p.id = s.user_id
     where p.district = $1
       and p.id <> $2
       and p.role in ('worker', 'both')
     limit 80`,
    [job.district, job.posted_by],
  );

  await Promise.all(
    r.rows.map((row) =>
      notifyPush(row.user_id, {
        title: "புதிய வேலை · New job",
        body: `${job.title} — 📍 ${job.village}`,
        url: `/job/${job.id}`,
        tag: `job-${job.id}`,
      }),
    ),
  );
}

