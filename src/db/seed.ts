/**
 * Seed: districts + sample Tamil profiles & jobs so the app has data to show.
 * Safe to run repeatedly (sample data is inserted only once).
 * Run with:  bun run seed
 */
import { pool } from "./pool";
import { addDistrict } from "./districts";

const DISTRICTS = [
  "Madurai",
  "Coimbatore",
  "Thanjavur",
  "Salem",
  "Tirunelveli",
  "Erode",
  "Vellore",
  "Dindigul",
];

const DEMO_PIN = "123456";

function dateAhead(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  console.log("Districts...");
  for (const d of DISTRICTS) {
    await addDistrict(d);
    console.log(`  ✓ ${d}`);
  }

  const has = await pool.query(`select 1 from jobs limit 1`);
  if (has.rowCount) {
    console.log("Sample data already present — skipping.");
    await pool.end();
    return;
  }

  const pinHash = await Bun.password.hash(DEMO_PIN);

  const addProfile = async (
    phone: string,
    name: string,
    district: string,
    village: string,
    role: string,
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `insert into profiles (phone, full_name, pin_hash, district, village, role)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [phone, name, pinHash, district, village, role],
    );
    return r.rows[0]!.id;
  };

  const addJob = async (
    poster: string,
    title: string,
    description: string,
    jobType: string,
    workers: number,
    wage: number,
    wageType: string,
    daysAhead: number,
    district: string,
    village: string,
  ): Promise<void> => {
    await pool.query(
      `insert into jobs
         (posted_by, title, description, job_type, workers_needed,
          wage_amount, wage_type, job_date, district, village)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        poster,
        title,
        description,
        jobType,
        workers,
        wage,
        wageType,
        dateAhead(daysAhead),
        district,
        village,
      ],
    );
  };

  console.log("Sample data...");

  // --- Madurai ---
  const murugan = await addProfile(
    "9000000001",
    "முருகன்",
    "madurai",
    "மேலூர்",
    "employer",
  );
  await addProfile("9000000002", "லட்சுமி", "madurai", "மேலூர்", "worker");
  const selvam = await addProfile(
    "9000000003",
    "செல்வம்",
    "madurai",
    "திருமங்கலம்",
    "both",
  );
  await addJob(
    murugan,
    "நெல் அறுவடைக்கு 5 பேர் தேவை",
    "நாளை காலை 7 மணிக்கு வரவேண்டும். மதிய சாப்பாடு உண்டு.",
    "farming",
    5,
    500,
    "per_day",
    1,
    "madurai",
    "மேலூர்",
  );
  await addJob(
    murugan,
    "தென்னை மரம் ஏற ஆள் தேவை",
    "10 மரங்கள். ஒரு நாள் வேலை.",
    "coconut_climbing",
    1,
    600,
    "per_job",
    2,
    "madurai",
    "மேலூர்",
  );
  await addJob(
    selvam,
    "மாட்டுக் கொட்டகை சுத்தம் செய்ய உதவி",
    "காலை நேர வேலை மட்டும்.",
    "cattle_care",
    2,
    400,
    "per_day",
    1,
    "madurai",
    "திருமங்கலம்",
  );

  // --- Thanjavur ---
  const kannan = await addProfile(
    "9100000001",
    "கண்ணன்",
    "thanjavur",
    "பட்டுக்கோட்டை",
    "employer",
  );
  await addProfile(
    "9100000002",
    "மீனா",
    "thanjavur",
    "பட்டுக்கோட்டை",
    "worker",
  );
  await addJob(
    kannan,
    "திருமணச் சமையலுக்கு உதவியாளர்கள் தேவை",
    "3 நாள் வேலை. சமையல் தெரிந்தவர்கள் வரவும்.",
    "cooking",
    4,
    700,
    "per_day",
    5,
    "thanjavur",
    "பட்டுக்கோட்டை",
  );
  await addJob(
    kannan,
    "முதியவருக்கு ஒரு நாள் காப்பாளர் தேவை",
    "பகல் நேரம் மட்டும் கவனிக்க வேண்டும்.",
    "elderly_care",
    1,
    550,
    "per_day",
    3,
    "thanjavur",
    "பட்டுக்கோட்டை",
  );

  console.log("✓ Seed complete.");
  console.log("Demo login → Phone: 9000000001 · PIN: 123456");
  await pool.end();
}

seed().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
