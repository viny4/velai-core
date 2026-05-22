/**
 * Loads Tamil Nadu districts + places (post offices) into the database.
 * Source: India Post all-India directory, filtered to TN — one row per post
 * office (~11,800), so villages/towns are searchable by name.
 * Run with:  bun run import-pincodes
 */
import { pool } from "./pool";
import { slugify } from "./districts";
import placeData from "./data/tn-places.json";

interface Row {
  p: string; // pincode
  n: string; // place / post office name
  d: string; // district
  lat: number | null;
  lng: number | null;
}

async function importPincodes() {
  const rows = placeData as Row[];

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

  // Places — rebuild the reference table (one row per post office).
  await pool.query(`drop table if exists pincodes`);
  await pool.query(`
    create table pincodes (
      id       serial primary key,
      pincode  text not null,
      place    text not null,
      district text not null,
      lat      double precision,
      lng      double precision
    );
    create index pincodes_pincode_idx on pincodes(pincode);
    create index pincodes_district_idx on pincodes(district);
  `);
  await pool.query(
    `insert into pincodes (pincode, place, district, lat, lng)
     select * from unnest(
       $1::text[], $2::text[], $3::text[], $4::float8[], $5::float8[]
     )`,
    [
      rows.map((r) => r.p),
      rows.map((r) => r.n),
      rows.map((r) => r.d),
      rows.map((r) => r.lat),
      rows.map((r) => r.lng),
    ],
  );
  console.log(`✓ ${rows.length} places (post offices)`);
  await pool.end();
}

importPincodes().catch((e) => {
  console.error("Pincode import failed:", e);
  process.exit(1);
});
