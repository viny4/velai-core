import { Router } from "express";
import { pool } from "../db/pool";
import { getDistrict } from "../db/districts";
import {
  signToken,
  signOnboardingToken,
  verifyOnboardingToken,
} from "../lib/jwt";
import { verifyGoogleIdToken } from "../lib/google";
import { ApiError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";

const router = Router();
const ROLES = ["worker", "employer", "both"];

/** Build the { token, profile, district } payload returned on login. */
function buildSession(
  profile: any,
  district: { slug: string; name: string },
) {
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
      email: profile.email ?? null,
      avatar_url: profile.avatar_url ?? null,
    },
    district: { slug: district.slug, name: district.name },
  };
}

/**
 * POST /api/auth/register — phone + 6-digit PIN, no SMS.
 * The district is stored on the profile (it is not needed again at login).
 */
router.post("/register", async (req, res) => {
  const { district, phone, pin, full_name, role, village } = req.body ?? {};

  if (!district) throw new ApiError(400, "Please select your district");
  if (!/^\d{10}$/.test(String(phone ?? "")))
    throw new ApiError(400, "Enter a valid 10-digit phone number");
  if (!/^\d{6}$/.test(String(pin ?? "")))
    throw new ApiError(400, "PIN must be exactly 6 digits");
  if (typeof full_name !== "string" || !full_name.trim())
    throw new ApiError(400, "Please enter your name");
  if (typeof village !== "string" || !village.trim())
    throw new ApiError(400, "Please enter your village");
  const userRole = ROLES.includes(role) ? role : "both";

  const d = await getDistrict(String(district));
  const pinHash = await Bun.password.hash(String(pin));

  let profile;
  try {
    const r = await pool.query(
      `insert into profiles (phone, full_name, pin_hash, role, district, village)
       values ($1,$2,$3,$4,$5,$6)
       returning id, phone, full_name, role, village`,
      [String(phone), full_name.trim(), pinHash, userRole, d.slug, village.trim()],
    );
    profile = r.rows[0]!;
  } catch (e) {
    if ((e as { code?: string })?.code === "23505")
      throw new ApiError(
        409,
        "An account with this phone number already exists. Please login.",
      );
    throw e;
  }

  res.status(201).json(buildSession(profile, d));
});

/** POST /api/auth/login — phone + PIN. No district needed. */
router.post("/login", async (req, res) => {
  const { phone, pin } = req.body ?? {};
  if (!phone || !pin)
    throw new ApiError(400, "Enter your phone number and PIN");

  const r = await pool.query(
    `select p.id, p.phone, p.full_name, p.role, p.village, p.email,
            p.avatar_url, p.pin_hash, p.district, d.name as district_name
     from profiles p
     join districts d on d.slug = p.district
     where p.phone = $1`,
    [String(phone)],
  );
  const profile = r.rows[0];
  if (!profile) throw new ApiError(401, "No account found for this phone number");
  if (!profile.pin_hash)
    throw new ApiError(
      401,
      "This account uses Google sign-in. Please tap 'Sign in with Google'.",
    );

  const ok = await Bun.password.verify(String(pin), profile.pin_hash);
  if (!ok) throw new ApiError(401, "Wrong PIN. Please try again.");

  res.json(
    buildSession(profile, {
      slug: profile.district,
      name: profile.district_name,
    }),
  );
});

/**
 * POST /api/auth/google
 * Verifies a Google ID token. Returns a session for a known user, or
 * { needs_onboarding } + a short-lived token for a first-time user.
 */
router.post("/google", async (req, res) => {
  const { id_token } = req.body ?? {};
  if (!id_token) throw new ApiError(400, "Missing Google sign-in token");

  const g = await verifyGoogleIdToken(String(id_token));

  const r = await pool.query(
    `select p.id, p.phone, p.full_name, p.role, p.village, p.email,
            p.avatar_url, p.district, d.name as district_name
     from profiles p
     join districts d on d.slug = p.district
     where p.google_sub = $1`,
    [g.sub],
  );

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

  // First-time Google user — needs to pick a district.
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
 * POST /api/auth/google/complete
 * Finishes first-time Google sign-up: creates the profile in the chosen
 * district. A phone number is still required — it powers the call feature.
 */
router.post("/google/complete", async (req, res) => {
  const { onboarding_token, district, village, role, phone } = req.body ?? {};
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

  if (!district) throw new ApiError(400, "Please select your district");
  if (!/^\d{10}$/.test(String(phone ?? "")))
    throw new ApiError(400, "Enter a valid 10-digit phone number");
  if (typeof village !== "string" || !village.trim())
    throw new ApiError(400, "Please enter your village");
  const userRole = ROLES.includes(role) ? role : "both";

  const d = await getDistrict(String(district));

  let profile;
  try {
    const r = await pool.query(
      `insert into profiles
         (phone, full_name, pin_hash, email, google_sub, avatar_url, role, district, village)
       values ($1,$2,null,$3,$4,$5,$6,$7,$8)
       returning id, phone, full_name, role, village, email, avatar_url`,
      [
        String(phone),
        ob.name,
        ob.email,
        ob.google_sub,
        ob.picture,
        userRole,
        d.slug,
        village.trim(),
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

  res.status(201).json(buildSession(profile, d));
});

/** GET /api/auth/me — current profile, used to restore a session. */
router.get("/me", requireAuth, async (req, res) => {
  const auth = req.auth!;
  const r = await pool.query(
    `select p.id, p.phone, p.full_name, p.role, p.village, p.email,
            p.avatar_url, p.district, d.name as district_name
     from profiles p
     join districts d on d.slug = p.district
     where p.id = $1`,
    [auth.sub],
  );
  if (!r.rowCount) throw new ApiError(404, "Profile not found");
  const profile = r.rows[0]!;
  res.json(
    buildSession(profile, {
      slug: profile.district,
      name: profile.district_name,
    }),
  );
});

export default router;
