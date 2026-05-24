import { Router } from "express";
import { pool } from "../db/pool";
import { lookupPincode, searchPlaces } from "../db/pincodes";
import { slugify } from "../db/districts";
import { ApiError } from "../lib/errors";

const router = Router();

/**
 * GET /api/pincodes/nearest?lat=&lng=&n=
 * Returns the N closest pincodes to a coordinate (default 5), nearest first.
 * Used by the GPS button in LocationPicker to suggest a village name when
 * the user enables location. Distance via in-SQL haversine.
 */
router.get("/nearest", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const n = Math.min(20, Math.max(1, Number(req.query.n ?? 5)));
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    throw new ApiError(400, "lat and lng are required numbers");

  const r = await pool.query<{
    pincode: string; place: string; district: string;
    lat: number; lng: number; km: number;
  }>(
    `select pincode, place, district, lat, lng,
            (6371 * acos(least(1, greatest(-1,
              cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2))
              + sin(radians($1)) * sin(radians(lat))
            )))) as km
     from pincodes
     where lat is not null and lng is not null
     order by km asc
     limit $3`,
    [lat, lng, n],
  );

  res.json({
    results: r.rows.map((p) => ({
      pincode: p.pincode,
      place: p.place,
      district: p.district,
      district_slug: slugify(p.district),
      lat: p.lat,
      lng: p.lng,
      distance_km: Math.round(p.km * 10) / 10,
    })),
  });
});

/** GET /api/pincodes/search?q=... — search places by village name or pincode. */
router.get("/search", async (req, res) => {
  const results = await searchPlaces(String(req.query.q ?? ""));
  res.json({
    results: results.map((r) => ({
      pincode: r.pincode,
      place: r.place,
      district: r.district,
      district_slug: slugify(r.district),
      lat: r.lat,
      lng: r.lng,
    })),
  });
});

/** GET /api/pincodes/:code — validate a pincode and return its area/district. */
router.get("/:code", async (req, res) => {
  const code = String(req.params.code);
  if (!/^\d{6}$/.test(code))
    throw new ApiError(400, "Enter a valid 6-digit pincode");

  const info = await lookupPincode(code);
  if (!info)
    throw new ApiError(
      404,
      "Pincode not found. Please check it or try a nearby one.",
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
