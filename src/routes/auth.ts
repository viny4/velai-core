import { Router } from "express";
import { pool } from "../db/pool";
import { addDistrict } from "../db/districts";
import { lookupPincode } from "../db/pincodes";
import {
  signToken,
  signOnboardingToken,
  verifyOnboardingToken,
} from "../lib/jwt";
import { verifyGoogleIdToken } from "../lib/google";
import { ApiError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { transliteratePair, pickLang, localizeRow } from "../lib/i18n";

const router = Router();
const ROLES = ["worker", "employer", "both"];

/**
 * Resolve a sign-up location: validate the pincode, ensure its district row
 * exists, and pick coordinates — precise GPS if the client sent it, otherwise
 * the pincode's centroid.
 */
async function resolveLocation(pincode: string, lat: unknown, lng: unknown) {
  const info = await lookupPincode(pincode);
  if (!info)
    throw new ApiError(
      404,
      "Pincode not found. Please check it or try a nearby pincode.",
    );
  const district = await addDistrict(info.district);
  const gLat = Number(lat);
  const gLng = Number(lng);
  const useGps =
    Number.isFinite(gLat) && Number.isFinite(gLng) && gLat !== 0 && gLng !== 0;
  return {
    district: { slug: district.slug, name: district.name },
    pincode: info.pincode,
    lat: useGps ? gLat : info.lat,
    lng: useGps ? gLng : info.lng,
  };
}

/** Build the { token, profile, district } payload returned on login. */
function buildSession(profile: any, district: { slug: string; name: string }) {
  const token = signToken({
    sub: profile.id,
    district: district.slug,
    name: profile.full_name,
    role: profile.role,
    phone: profile.phone,
  });
  return {
    token,
    profile: {
      id: profile.id,
      phone: profile.phone,
      full_name: profile.full_name,
      role: profile.role,
      district: district.slug,
      village: profile.village,
      pincode: profile.pincode ?? null,
      lat: profile.lat ?? null,
      lng: profile.lng ?? null,
      email: profile.email ?? null,
      avatar_url: profile.avatar_url ?? null,
    },
    district: { slug: district.slug, name: district.name },
  };
}

/**
 * POST /api/auth/google — sign in with Google.
 * Returning user → a full session. First-time user → { needs_onboarding }
 * with a short-lived token to finish sign-up.
 */
router.post("/google", async (req, res) => {
  const { id_token } = req.body ?? {};
  if (!id_token) throw new ApiError(400, "Missing Google sign-in token");

  const g = await verifyGoogleIdToken(String(id_token));

  // 1. Primary lookup: stable Google `sub`. This is what we set on every
  //    successful onboarding.
  let r = await pool.query(
    `select p.id, p.phone, p.full_name, p.role, p.village, p.email,
            p.avatar_url, p.pincode, p.lat, p.lng,
            p.district, d.name as district_name
     from profiles p
     join districts d on d.slug = p.district
     where p.google_sub = $1
     limit 1`,
    [g.sub],
  );

  // 2. Fallback: match by EMAIL and link the google_sub on the fly.
  //    Covers profiles created via the manage CLI, the seed, or any older
  //    flow where google_sub never got stored. Without this, a returning
  //    Google user would be pushed through onboarding every time.
  if (!r.rowCount && g.email) {
    const upd = await pool.query(
      `update profiles set google_sub = $1, avatar_url = coalesce(avatar_url, $3)
       where email = $2
       returning id`,
      [g.sub, g.email, g.picture],
    );
    if (upd.rowCount) {
      r = await pool.query(
        `select p.id, p.phone, p.full_name, p.role, p.village, p.email,
                p.avatar_url, p.pincode, p.lat, p.lng,
                p.district, d.name as district_name
         from profiles p
         join districts d on d.slug = p.district
         where p.id = $1`,
        [upd.rows[0]!.id],
      );
    }
  }

  if (r.rowCount) {
    const profile = r.rows[0]!;
    res.json(
      buildSession(profile, {
        slug: profile.district,
        name: profile.district_name,
      }),
    );
    return;
  }

  const onboarding_token = signOnboardingToken({
    kind: "google_onboarding",
    google_sub: g.sub,
    email: g.email,
    name: g.name,
    picture: g.picture,
  });
  res.json({
    needs_onboarding: true,
    google: { email: g.email, name: g.name, picture: g.picture },
    onboarding_token,
  });
});

/**
 * POST /api/auth/google/complete — finish first-time Google sign-up.
 * Collects the phone number (needed for the call feature) + location.
 */
router.post("/google/complete", async (req, res) => {
  const { onboarding_token, pincode, lat, lng, village, role, phone } =
    req.body ?? {};
  if (!onboarding_token) throw new ApiError(400, "Missing onboarding token");

  let ob;
  try {
    ob = verifyOnboardingToken(String(onboarding_token));
  } catch {
    throw new ApiError(
      401,
      "Your sign-up session expired. Please sign in with Google again.",
    );
  }

  if (!/^\d{6}$/.test(String(pincode ?? "")))
    throw new ApiError(400, "Please enter a valid 6-digit pincode");
  if (!/^\d{10}$/.test(String(phone ?? "")))
    throw new ApiError(400, "Enter a valid 10-digit phone number");
  if (typeof village !== "string" || !village.trim())
    throw new ApiError(400, "Please enter your village");
  const userRole = ROLES.includes(role) ? role : "both";

  // Already onboarded? Just sign them in instead of trying to insert again.
  // (Happens when the user double-submits, or when the form is replayed.)
  {
    const existing = await pool.query(
      `select p.id, p.phone, p.full_name, p.role, p.village, p.email,
              p.avatar_url, p.pincode, p.lat, p.lng,
              p.district, d.name as district_name
       from profiles p join districts d on d.slug = p.district
       where p.google_sub = $1 or p.email = $2
       limit 1`,
      [ob.google_sub, ob.email],
    );
    if (existing.rowCount) {
      const p = existing.rows[0]!;
      // Make sure the google_sub is linked for next time.
      await pool.query(
        `update profiles set google_sub = $1 where id = $2 and google_sub is null`,
        [ob.google_sub, p.id],
      );
      res.json(
        buildSession(p, { slug: p.district, name: p.district_name }),
      );
      return;
    }
  }

  const loc = await resolveLocation(String(pincode), lat, lng);

  // Names + villages are STORED in both scripts (transliteration preserves
  // the sound: "முருகன்" ↔ "Murugan"). The frontend then renders whichever
  // language is currently toggled on, with no UI churn.
  const [namePair, villagePair] = await Promise.all([
    transliteratePair(ob.name),
    transliteratePair(village.trim()),
  ]);

  let profile;
  try {
    const r = await pool.query(
      `insert into profiles
         (phone, full_name, pin_hash, email, google_sub, avatar_url,
          role, district, village, pincode, lat, lng,
          full_name_ta, full_name_en, village_ta, village_en)
       values ($1,$2,null,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       returning id, phone, full_name, role, village, pincode, lat, lng,
                 email, avatar_url`,
      [
        String(phone),
        ob.name,
        ob.email,
        ob.google_sub,
        ob.picture,
        userRole,
        loc.district.slug,
        village.trim(),
        loc.pincode,
        loc.lat,
        loc.lng,
        namePair.ta,
        namePair.en,
        villagePair.ta,
        villagePair.en,
      ],
    );
    profile = r.rows[0]!;
  } catch (e) {
    if ((e as { code?: string })?.code === "23505")
      throw new ApiError(
        409,
        "This phone or Google account is already registered. Try signing in.",
      );
    throw e;
  }

  res.status(201).json(buildSession(profile, loc.district));
});

/** GET /api/auth/me — current profile, used to restore a session. */
router.get("/me", requireAuth, async (req, res) => {
  const auth = req.auth!;
  const lang = pickLang(req);
  const r = await pool.query(
    `select p.id, p.phone, p.full_name, p.full_name_ta, p.full_name_en,
            p.role,
            p.village, p.village_ta, p.village_en,
            p.email, p.avatar_url, p.pincode, p.lat, p.lng,
            p.district,
            d.name as district_name, d.name_ta as district_name_ta
     from profiles p
     join districts d on d.slug = p.district
     where p.id = $1`,
    [auth.sub],
  );
  if (!r.rowCount) throw new ApiError(404, "Profile not found");
  const profile = r.rows[0]!;
  // Return the right-language name + village; the frontend reads these straight.
  localizeRow(profile, lang, ["full_name", "village"]);
  const districtName =
    lang === "ta" ? profile.district_name_ta || profile.district_name : profile.district_name;
  res.json(
    buildSession(profile, { slug: profile.district, name: districtName }),
  );
});

export default router;
