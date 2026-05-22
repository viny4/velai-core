import { pool } from "./pool";

export interface PincodeInfo {
  pincode: string;
  place: string;
  district: string;
  lat: number | null;
  lng: number | null;
}

/** Look up a pincode → its area, district and coordinates. */
export async function lookupPincode(code: string): Promise<PincodeInfo | null> {
  const r = await pool.query<PincodeInfo>(
    `select pincode, place, district, lat, lng from pincodes
     where pincode = $1
     order by (lat is not null) desc
     limit 1`,
    [code],
  );
  return r.rows[0] ?? null;
}

/**
 * Search places by village/town name or by pincode.
 * Returns up to 10 matches for the sign-up location picker.
 */
export async function searchPlaces(q: string): Promise<PincodeInfo[]> {
  const query = q.trim();
  if (query.length < 2) return [];

  // Numeric query → pincode prefix search.
  if (/^\d{3,6}$/.test(query)) {
    const r = await pool.query<PincodeInfo>(
      `select distinct on (pincode) pincode, place, district, lat, lng
       from pincodes where pincode like $1
       order by pincode limit 10`,
      [query + "%"],
    );
    return r.rows;
  }

  // Text query → village/town name search (exact match first).
  const r = await pool.query<PincodeInfo>(
    `select pincode, place, district, lat, lng from pincodes
     where place ilike $1
     order by (lower(place) = lower($2)) desc, length(place), place
     limit 10`,
    ["%" + query + "%", query],
  );
  return r.rows;
}
