/**
 * Profile endpoints — edit your own profile, view others, manage your
 * work-photo gallery.
 *
 *   GET    /api/profile/me           full editable profile
 *   PATCH  /api/profile/me           update fields the worker can change
 *   GET    /api/profile/:id          public view (used from job detail)
 *   POST   /api/profile/me/photos    add one photo { image_url, caption? }
 *   DELETE /api/profile/me/photos/:photoId   remove
 *
 * Photos travel as data URLs (frontend resizes to ~600x600). Cap is 1 MB
 * per photo to keep the database small.
 */
import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { isUuid } from "../lib/validate";
import { transliteratePair, pickLang, localizeRow } from "../lib/i18n";
import { lookupPincode } from "../db/pincodes";
import { slugify } from "../db/districts";

const router = Router();

const MAX_PHOTO_BYTES = 1_000_000; // 1 MB per image, base64-encoded
const ROLES = new Set(["worker", "employer", "both"]);

/* /me/* routes are declared FIRST so they take precedence over /:id. */

/** Get your own profile (with editable fields). */
router.get("/me/edit", requireAuth, async (req, res) => {
  const r = await pool.query(
    `select id, full_name, phone, email, role, skills, avatar_url,
            village, pincode, lat, lng, district
     from profiles where id = $1`,
    [req.auth!.sub],
  );
  if (!r.rowCount) throw new ApiError(404, "Profile not found");
  res.json({ profile: r.rows[0] });
});

/**
 * Update editable fields on the signed-in user's profile.
 * Body: any of { full_name, role, skills[], avatar_url, village, pincode,
 *               lat, lng, phone }.
 * Changing the village re-transliterates both scripts AND, if the pincode
 * is provided, re-derives district from it (a real move).
 */
router.patch("/me", requireAuth, async (req, res) => {
  const userId = req.auth!.sub;
  const b = req.body ?? {};

  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (typeof b.full_name === "string" && b.full_name.trim()) {
    const pair = await transliteratePair(b.full_name.trim());
    add("full_name", b.full_name.trim());
    add("full_name_ta", pair.ta);
    add("full_name_en", pair.en);
  }
  if (typeof b.role === "string" && ROLES.has(b.role)) add("role", b.role);
  if (Array.isArray(b.skills)) {
    const cleaned = b.skills
      .filter((s: unknown) => typeof s === "string")
      .map((s: string) => s.trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 12);
    add("skills", cleaned);
  }
  if (typeof b.avatar_url === "string") {
    if (b.avatar_url.length > MAX_PHOTO_BYTES)
      throw new ApiError(413, "Avatar too large — please pick a smaller image.");
    add("avatar_url", b.avatar_url);
  }
  if (typeof b.phone === "string" && /^\d{10}$/.test(b.phone)) add("phone", b.phone);

  // Location change — handle as a unit so district stays consistent.
  if (typeof b.village === "string" && b.village.trim()) {
    const pair = await transliteratePair(b.village.trim());
    add("village", b.village.trim());
    add("village_ta", pair.ta);
    add("village_en", pair.en);
  }
  if (typeof b.pincode === "string" && /^\d{6}$/.test(b.pincode)) {
    add("pincode", b.pincode);
    // Re-derive district from the new pincode so the feed shows nearby jobs.
    const info = await lookupPincode(b.pincode);
    if (info) {
      add("district", slugify(info.district));
      if (info.lat != null) add("lat", info.lat);
      if (info.lng != null) add("lng", info.lng);
    }
  }
  // Explicit GPS overrides any pincode lat/lng.
  if (b.lat != null && Number.isFinite(Number(b.lat))) add("lat", Number(b.lat));
  if (b.lng != null && Number.isFinite(Number(b.lng))) add("lng", Number(b.lng));

  if (!sets.length) throw new ApiError(400, "Nothing to update");
  params.push(userId);

  const r = await pool.query(
    `update profiles set ${sets.join(", ")} where id = $${params.length}
     returning id, full_name, phone, role, skills, avatar_url,
               village, pincode, lat, lng, district`,
    params,
  );
  res.json({ profile: r.rows[0] });
});

/** Add one work photo (data URL). */
router.post("/me/photos", requireAuth, async (req, res) => {
  const userId = req.auth!.sub;
  const image_url = String(req.body?.image_url ?? "");
  const caption = String(req.body?.caption ?? "").trim().slice(0, 140);
  if (!image_url.startsWith("data:image/") && !image_url.startsWith("https://"))
    throw new ApiError(400, "Invalid image");
  if (image_url.length > MAX_PHOTO_BYTES)
    throw new ApiError(413, "Image too large — please pick a smaller one.");

  const count = await pool.query<{ n: string }>(
    "select count(*)::text as n from work_photos where user_id = $1",
    [userId],
  );
  if (Number(count.rows[0]!.n) >= 12)
    throw new ApiError(400, "You've reached the 12-photo limit. Remove one first.");

  const r = await pool.query(
    `insert into work_photos (user_id, image_url, caption)
     values ($1, $2, $3) returning id, image_url, caption, created_at`,
    [userId, image_url, caption],
  );
  res.status(201).json({ photo: r.rows[0] });
});

/** Remove one of your own photos. */
router.delete("/me/photos/:photoId", requireAuth, async (req, res) => {
  if (!isUuid(req.params.photoId)) throw new ApiError(404, "Photo not found");
  const r = await pool.query(
    "delete from work_photos where id = $1 and user_id = $2 returning id",
    [req.params.photoId, req.auth!.sub],
  );
  if (!r.rowCount) throw new ApiError(404, "Photo not found");
  res.json({ ok: true });
});

/** Public view of a profile + their gallery + rating aggregate.
 *  Declared AFTER /me/* so the literal paths win. */
router.get("/:id", optionalAuth, async (req, res) => {
  if (!isUuid(req.params.id)) throw new ApiError(404, "User not found");
  const lang = pickLang(req);

  const r = await pool.query(
    `select p.id, p.full_name, p.full_name_ta, p.full_name_en,
            p.role, p.avatar_url, p.skills,
            p.village, p.village_ta, p.village_en, p.district,
            d.name as district_name, d.name_ta as district_name_ta,
            (select avg(stars)::numeric(3,2) from ratings where ratee_id = p.id) as rating_avg,
            (select count(*)::int from ratings where ratee_id = p.id) as rating_count,
            (select count(*)::int from jobs where posted_by = p.id and status = 'completed') as completed_count
     from profiles p join districts d on d.slug = p.district
     where p.id = $1`,
    [req.params.id],
  );
  if (!r.rowCount) throw new ApiError(404, "User not found");
  const profile = r.rows[0]!;
  localizeRow(profile, lang, ["full_name", "village"]);
  profile.district_name =
    lang === "ta" ? profile.district_name_ta || profile.district_name : profile.district_name;
  delete profile.full_name_ta;
  delete profile.full_name_en;
  delete profile.village_ta;
  delete profile.village_en;
  delete profile.district_name_ta;

  const photos = await pool.query(
    `select id, image_url, caption, created_at
     from work_photos where user_id = $1 order by created_at desc limit 24`,
    [req.params.id],
  );

  res.json({ profile, photos: photos.rows });
});

export default router;
