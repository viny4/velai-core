/**
 * Seed: sample Tamil profiles & jobs with real pincodes + coordinates.
 * Run AFTER migrate + import-pincodes (districts & pincodes must exist).
 * Run with:  bun run seed
 */
import { pool } from "./pool";
import { slugify } from "./districts";

const DEMO_PIN = "123456";

function dateAhead(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Loc {
  pincode: string;
  lat: number;
  lng: number;
}

async function pickPincodes(district: string, n: number): Promise<Loc[]> {
  const r = await pool.query<Loc>(
    `select pincode, lat, lng from pincodes where district = $1
     order by random() limit $2`,
    [district, n],
  );
  return r.rows;
}

async function seed() {
  const has = await pool.query(`select 1 from jobs limit 1`);
  if (has.rowCount) {
    console.log("Sample data already present — skipping.");
    await pool.end();
    return;
  }

  const madurai = await pickPincodes("Madurai", 3);
  const thanjavur = await pickPincodes("Thanjavur", 2);
  if (madurai.length < 3 || thanjavur.length < 2) {
    console.error("Pincodes missing — run 'bun run import-pincodes' first.");
    process.exit(1);
  }

  const pinHash = await Bun.password.hash(DEMO_PIN);

  const addProfile = async (
    phone: string,
    name: string,
    districtName: string,
    village: string,
    role: string,
    loc: Loc,
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `insert into profiles
         (phone, full_name, pin_hash, role, district, village, pincode, lat, lng)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [
        phone,
        name,
        pinHash,
        role,
        slugify(districtName),
        village,
        loc.pincode,
        loc.lat,
        loc.lng,
      ],
    );
    return r.rows[0]!.id;
  };

  const addJob = async (
    posterId: string,
    districtName: string,
    loc: Loc,
    title: string,
    description: string,
    jobType: string,
    workers: number,
    wage: number,
    wageType: string,
    daysAhead: number,
    village: string,
  ): Promise<void> => {
    await pool.query(
      `insert into jobs
         (posted_by, title, description, job_type, workers_needed,
          wage_amount, wage_type, job_date, district, village, pincode, lat, lng)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        posterId,
        title,
        description,
        jobType,
        workers,
        wage,
        wageType,
        dateAhead(daysAhead),
        slugify(districtName),
        village,
        loc.pincode,
        loc.lat,
        loc.lng,
      ],
    );
  };

  console.log("Sample data...");

  // --- Madurai (three nearby pincodes for a realistic distance spread) ---
  const murugan = await addProfile(
    "9000000001", "முருகன்", "Madurai", "மேலூர்", "employer", madurai[0]!,
  );
  await addProfile(
    "9000000002", "லட்சுமி", "Madurai", "மேலூர்", "worker", madurai[1]!,
  );
  const selvam = await addProfile(
    "9000000003", "செல்வம்", "Madurai", "திருமங்கலம்", "both", madurai[2]!,
  );
  await addJob(
    murugan, "Madurai", madurai[0]!,
    "நெல் அறுவடைக்கு 5 பேர் தேவை",
    "நாளை காலை 7 மணிக்கு வரவேண்டும். மதிய சாப்பாடு உண்டு.",
    "farming", 5, 500, "per_day", 1, "மேலூர்",
  );
  await addJob(
    murugan, "Madurai", madurai[0]!,
    "தென்னை மரம் ஏற ஆள் தேவை",
    "10 மரங்கள். ஒரு நாள் வேலை.",
    "coconut_climbing", 1, 600, "per_job", 2, "மேலூர்",
  );
  await addJob(
    selvam, "Madurai", madurai[2]!,
    "மாட்டுக் கொட்டகை சுத்தம் செய்ய உதவி",
    "காலை நேர வேலை மட்டும்.",
    "cattle_care", 2, 400, "per_day", 1, "திருமங்கலம்",
  );

  // --- Thanjavur ---
  const kannan = await addProfile(
    "9100000001", "கண்ணன்", "Thanjavur", "பட்டுக்கோட்டை", "employer", thanjavur[0]!,
  );
  await addProfile(
    "9100000002", "மீனா", "Thanjavur", "பட்டுக்கோட்டை", "worker", thanjavur[1]!,
  );
  await addJob(
    kannan, "Thanjavur", thanjavur[0]!,
    "திருமணச் சமையலுக்கு உதவியாளர்கள் தேவை",
    "3 நாள் வேலை. சமையல் தெரிந்தவர்கள் வரவும்.",
    "cooking", 4, 700, "per_day", 5, "பட்டுக்கோட்டை",
  );
  await addJob(
    kannan, "Thanjavur", thanjavur[0]!,
    "முதியவருக்கு ஒரு நாள் காப்பாளர் தேவை",
    "பகல் நேரம் மட்டும் கவனிக்க வேண்டும்.",
    "elderly_care", 1, 550, "per_day", 3, "பட்டுக்கோட்டை",
  );

  console.log("✓ Seed complete.");
  console.log("Demo login → Phone: 9000000001 · PIN: 123456");
  await pool.end();
}

seed().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
