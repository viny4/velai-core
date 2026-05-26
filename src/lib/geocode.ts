/**
 * Reverse geocoding via OpenStreetMap Nominatim — free, no API key, accurate
 * down to village/locality level.
 *
 * We use it to convert a GPS coord into a REAL address (village name,
 * neighbourhood, district), then pair that with our authoritative TN
 * pincode table for the pincode itself (since Nominatim's postcode field
 * is sometimes missing for small Indian villages).
 *
 * Rate limit: Nominatim's public instance is 1 request/second per IP.
 * Pilot scale fits comfortably; at production scale we'd self-host or use
 * a paid provider.
 */
import { logEvent } from "./events";

export interface ReverseGeo {
  /** Best village/town/suburb name we could find. */
  village: string;
  /** District / county. */
  district: string;
  state: string;
  postcode: string | null;
  /** Full one-line address from Nominatim — good for showing the user. */
  formatted: string;
  /** What part of the OSM hierarchy `village` came from (debug). */
  source: string;
}

export async function reverseGeocode(
  lat: number,
  lng: number,
  lang: "ta" | "en" = "en",
): Promise<ReverseGeo | null> {
  const start = Date.now();
  // zoom=16 gives suburb / neighbourhood granularity; zoom=14 = village/town.
  // We use 16 for rural India because villages are often inside larger panchayats.
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
    `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}` +
    `&zoom=16&addressdetails=1&accept-language=${lang === "ta" ? "ta,en" : "en"}`;
  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim's terms require an identifying User-Agent.
        "User-Agent": "Velai/1.0 (https://velai-app.vercel.app)",
      },
    });
    if (!res.ok) {
      logEvent({
        kind: "system",
        status: "warn",
        durationMs: Date.now() - start,
        message: `nominatim ${res.status}`,
        meta: { op: "reverse", lat, lng, status_code: res.status },
      });
      return null;
    }
    const data = (await res.json()) as any;
    const a = data?.address ?? {};
    // Walk down a preference list — Indian rural addresses can land on any of these.
    const fields: [string, string][] = [
      [a.village, "village"],
      [a.hamlet, "hamlet"],
      [a.suburb, "suburb"],
      [a.neighbourhood, "neighbourhood"],
      [a.quarter, "quarter"],
      [a.town, "town"],
      [a.city, "city"],
      [a.city_district, "city_district"],
    ];
    const picked = fields.find(([v]) => v) ?? ["", "none"];
    const district =
      a.county || a.state_district || a.district || a.city || "";

    logEvent({
      kind: "system",
      status: "ok",
      durationMs: Date.now() - start,
      message: `nominatim → ${picked[0] || "(empty)"}`,
      meta: {
        op: "reverse", lat, lng,
        village_source: picked[1], district, postcode: a.postcode ?? null,
      },
    });

    return {
      village: picked[0] || "",
      district,
      state: a.state || "",
      postcode: a.postcode || null,
      formatted: data?.display_name || "",
      source: picked[1],
    };
  } catch (e: any) {
    logEvent({
      kind: "system",
      status: "error",
      durationMs: Date.now() - start,
      message: "nominatim error",
      meta: { op: "reverse", lat, lng },
      error: String(e?.message ?? e),
    });
    return null;
  }
}
