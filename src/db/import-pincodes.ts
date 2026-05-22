/**
 * Loads Tamil Nadu districts + pincodes (from GeoNames data) into the database.
 * Run with:  bun run import-pincodes
 */
import { pool } from "./pool";
import { slugify } from "./districts";
import pincodeData from "./data/tn-pincodes.json";

interface Row {
  p: string; // pincode
  n: string; // place name
  d: string; // district
  lat: number;
  lng: number;
}

async function importPincodes() {
  const rows = pincodeData as Row[];

  // Districts — one row per distinct district name.
  const districtNames = [...new Set(rows.map((r) => r.d).filter(Boolean))].sort();
  for (const name of districtNames) {
    await pool.query(
      `insert into districts (name, slug) values ($1, $2)
       on conflict (slug) do update set name = excluded.name`,
      [name, slugify(name)],
    );
  }
  console.log(`✓ ${districtNames.length} districts`);

  // Pincodes — one batched insert via unnest (fast over the network).
  await pool.query(
    `insert into pincodes (pincode, place, district, lat, lng)
     select * from unnest(
       $1::text[], $2::text[], $3::text[], $4::float8[], $5::float8[]
     )
     on conflict (pincode) do update set
       place = excluded.place, district = excluded.district,
       lat = excluded.lat, lng = excluded.lng`,
    [
      rows.map((r) => r.p),
      rows.map((r) => r.n),
      rows.map((r) => r.d),
      rows.map((r) => r.lat),
      rows.map((r) => r.lng),
    ],
  );
  console.log(`✓ ${rows.length} pincodes`);
  await pool.end();
}

importPincodes().catch((e) => {
  console.error("Pincode import failed:", e);
  process.exit(1);
});
