import { pool } from "./pool";

export interface PincodeInfo {
  pincode: string;
  place: string;
  district: string;
  lat: number;
  lng: number;
}

/** Look up a pincode. Returns null if it is not in the dataset. */
export async function lookupPincode(code: string): Promise<PincodeInfo | null> {
  const r = await pool.query<PincodeInfo>(
    `select pincode, place, district, lat, lng from pincodes where pincode = $1`,
    [code],
  );
  return r.rows[0] ?? null;
}
