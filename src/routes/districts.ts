import { Router } from "express";
import { listDistricts, addDistrict } from "../db/districts";
import { config } from "../config";
import { ApiError } from "../lib/errors";
import { pickLang } from "../lib/i18n";

const router = Router();

/** GET /api/districts — districts for the sign-up dropdown (public).
 *  Honours Accept-Language so Tamil callers see Tamil names.
 *  Districts almost never change — cache aggressively to save bandwidth. */
router.get("/", async (req, res) => {
  res.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
  res.set("Vary", "Accept-Language");
  res.json({ districts: await listDistricts(pickLang(req)) });
});

/** POST /api/districts — onboard a new district (admin only).
 *  Header required:  X-Admin-Key: <ADMIN_KEY> */
router.post("/", async (req, res) => {
  if (req.headers["x-admin-key"] !== config.adminKey)
    throw new ApiError(403, "Admin key required");
  const name = req.body?.name;
  if (typeof name !== "string" || !name.trim())
    throw new ApiError(400, "District name is required");
  const district = await addDistrict(name.trim());
  res.status(201).json({ district });
});

export default router;
