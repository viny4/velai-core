import { Router } from "express";
import { lookupPincode } from "../db/pincodes";
import { slugify } from "../db/districts";
import { ApiError } from "../lib/errors";

const router = Router();

/** GET /api/pincodes/:code — validate a pincode and return its area,
 *  district and centre coordinates (used to autofill the sign-up form). */
router.get("/:code", async (req, res) => {
  const code = String(req.params.code);
  if (!/^\d{6}$/.test(code))
    throw new ApiError(400, "Enter a valid 6-digit pincode");

  const info = await lookupPincode(code);
  if (!info)
    throw new ApiError(
      404,
      "Pincode not found. Please check the number or try a nearby one.",
    );

  res.json({
    pincode: info.pincode,
    place: info.place,
    district: info.district,
    district_slug: slugify(info.district),
    lat: info.lat,
    lng: info.lng,
  });
});

export default router;
