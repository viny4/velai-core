/**
 * Velai management CLI — insert and inspect data.
 *
 *   bun run manage <command> [args]
 */
import { pool } from "./db/pool";
import { addDistrict, slugify } from "./db/districts";
import { JOB_TYPES } from "./db/schema";

const [cmd, ...args] = process.argv.slice(2);

function die(msg: string): never {
  throw new Error(msg);
}

function dateAhead(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Resolve a district arg (name or slug) to its slug + name. */
async function resolveDistrict(arg?: string) {
  if (!arg) die("District is required");
  const slug = slugify(arg);
  const r = await pool.query<{ slug: string; name: string }>(
    "select slug, name from districts where slug = $1",
    [slug],
  );
  if (!r.rowCount)
    die(`District '${arg}' not found. See: bun run manage districts`);
  return r.rows[0]!;
}

const commands: Record<string, () => Promise<void>> = {
  /** List all districts. */
  async districts() {
    const r = await pool.query<{ slug: string; name: string }>(
      "select slug, name from districts order by name",
    );
    console.log(`Districts (${r.rowCount}):`);
    for (const d of r.rows) console.log(`  ${d.slug.padEnd(16)} ${d.name}`);
  },

  /** Add a district. */
  async "add-district"() {
    const name = args.join(" ").trim();
    if (!name) die('Usage: add-district "<District Name>"');
    const d = await addDistrict(name);
    console.log(`✓ District added → ${d.name} (slug: ${d.slug})`);
  },

  /** List users — all, or in one district. */
  async users() {
    const where = args[0] ? "where p.district = $1" : "";
    const params = args[0] ? [(await resolveDistrict(args[0])).slug] : [];
    const r = await pool.query(
      `select p.phone, p.full_name, p.role, p.district, p.village
       from profiles p ${where} order by p.created_at`,
      params,
    );
    console.log(`Users (${r.rowCount}):`);
    for (const u of r.rows)
      console.log(
        `  ${u.phone}  ${String(u.full_name).padEnd(14)} [${u.role}]  ${u.district}/${u.village}`,
      );
  },

  /** Add a user. Usage: add-user <district> <phone> <name> <village> [role] [pin] */
  async "add-user"() {
    const [district, phone, name, village, role = "both", pin = "123456"] = args;
    if (!district || !phone || !name || !village)
      die("Usage: add-user <district> <phone> <name> <village> [role] [pin]");
    if (!/^\d{10}$/.test(phone!)) die("Phone must be 10 digits");
    if (!/^\d{6}$/.test(pin)) die("PIN must be 6 digits");
    if (!["worker", "employer", "both"].includes(role))
      die("role must be: worker | employer | both");
    const d = await resolveDistrict(district);
    const hash = await Bun.password.hash(pin);
    await pool.query(
      `insert into profiles (phone, full_name, pin_hash, role, district, village)
       values ($1,$2,$3,$4,$5,$6)`,
      [phone, name, hash, role, d.slug, village],
    );
    console.log(`✓ User "${name}" (${phone}) added to ${d.name}. PIN: ${pin}`);
  },

  /** List jobs — all, or in one district. */
  async jobs() {
    const where = args[0] ? "where j.district = $1" : "";
    const params = args[0] ? [(await resolveDistrict(args[0])).slug] : [];
    const r = await pool.query(
      `select j.title, j.job_type, j.wage_amount, j.job_date, j.status,
              j.district, p.full_name as poster
       from jobs j join profiles p on p.id = j.posted_by
       ${where} order by j.created_at desc`,
      params,
    );
    console.log(`Jobs (${r.rowCount}):`);
    for (const j of r.rows)
      console.log(
        `  [${String(j.status).padEnd(9)}] ${j.title} — ₹${j.wage_amount} ` +
          `(${j.job_type}, ${j.district}) by ${j.poster}`,
      );
  },

  /**
   * Add a job. The district is taken from the poster's profile.
   * Usage: add-job <poster_phone> <job_type> <wage> <YYYY-MM-DD> <workers> "<title>"
   */
  async "add-job"() {
    const [posterPhone, jobType, wage, date, workers, ...titleParts] = args;
    if (
      !posterPhone ||
      !jobType ||
      !wage ||
      !date ||
      !workers ||
      titleParts.length === 0
    )
      die(
        'Usage: add-job <poster_phone> <job_type> <wage> <YYYY-MM-DD> <workers> "<title>"',
      );
    if (!(JOB_TYPES as readonly string[]).includes(jobType!))
      die(`job_type must be one of:\n  ${JOB_TYPES.join(", ")}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date!)) die("Date must be YYYY-MM-DD");

    const p = await pool.query<{ id: string; district: string; village: string }>(
      "select id, district, village from profiles where phone = $1",
      [posterPhone],
    );
    if (!p.rowCount)
      die(`No user with phone ${posterPhone}. Add them first with: add-user`);

    const title = titleParts.join(" ");
    await pool.query(
      `insert into jobs
         (posted_by, title, job_type, workers_needed, wage_amount, job_date, district, village)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        p.rows[0]!.id,
        title,
        jobType,
        Number(workers),
        Number(wage),
        date,
        p.rows[0]!.district,
        p.rows[0]!.village,
      ],
    );
    console.log(`✓ Job "${title}" posted in ${p.rows[0]!.district}`);
  },

  /** Put a demo employer + 2 sample jobs into every district that has none. */
  async "fill-demo"() {
    const SAMPLES = [
      {
        job_type: "farming",
        title: "வயல் வேலைக்கு ஆட்கள் தேவை",
        wage: 450,
        days: 1,
        workers: 4,
      },
      {
        job_type: "housework",
        title: "வீட்டு வேலைக்கு உதவியாளர் தேவை",
        wage: 350,
        days: 2,
        workers: 1,
      },
    ];
    const districts = await pool.query<{ slug: string; name: string }>(
      "select slug, name from districts order by name",
    );
    const hash = await Bun.password.hash("123456");
    let idx = 0;
    for (const d of districts.rows) {
      idx++;
      const has = await pool.query(
        "select 1 from jobs where district = $1 limit 1",
        [d.slug],
      );
      if (has.rowCount) {
        console.log(`  ${d.name}: already has jobs — skipped`);
        continue;
      }
      const phone = "9990" + String(idx).padStart(6, "0");
      const pr = await pool.query<{ id: string }>(
        `insert into profiles (phone, full_name, pin_hash, role, district, village)
         values ($1,'டெமோ முதலாளி',$2,'employer',$3,$4)
         on conflict (phone) do update set full_name = excluded.full_name
         returning id`,
        [phone, hash, d.slug, d.name],
      );
      for (const s of SAMPLES) {
        await pool.query(
          `insert into jobs
             (posted_by, title, job_type, workers_needed, wage_amount, job_date, district, village)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            pr.rows[0]!.id,
            s.title,
            s.job_type,
            s.workers,
            s.wage,
            dateAhead(s.days),
            d.slug,
            d.name,
          ],
        );
      }
      console.log(`  ${d.name}: demo employer ${phone} (PIN 123456) + 2 jobs`);
    }
    console.log("✓ Every district now has data.");
  },

  /** Row counts per district. */
  async stats() {
    const r = await pool.query(
      `select d.name,
              (select count(*) from profiles p where p.district = d.slug) as users,
              (select count(*) from jobs j where j.district = d.slug) as jobs,
              (select count(*) from job_responses r
                 join jobs j on j.id = r.job_id
                 where j.district = d.slug) as responses
       from districts d order by d.name`,
    );
    console.log(
      "District".padEnd(16) + "Users".padEnd(8) + "Jobs".padEnd(8) + "Responses",
    );
    console.log("-".repeat(40));
    for (const row of r.rows)
      console.log(
        String(row.name).padEnd(16) +
          String(row.users).padEnd(8) +
          String(row.jobs).padEnd(8) +
          String(row.responses),
      );
  },
};

function help() {
  console.log(`Velai management CLI

  bun run manage districts
  bun run manage add-district "<District Name>"
  bun run manage users [district]
  bun run manage add-user <district> <phone> <name> <village> [role] [pin]
  bun run manage jobs [district]
  bun run manage add-job <poster_phone> <job_type> <wage> <YYYY-MM-DD> <workers> "<title>"
  bun run manage fill-demo
  bun run manage stats

  job_type: ${JOB_TYPES.join(", ")}
`);
}

async function main() {
  if (!cmd || !commands[cmd]) {
    help();
    if (cmd) process.exitCode = 1;
    return;
  }
  await commands[cmd]!();
}

main()
  .catch((e: unknown) => {
    const err = e as { message?: string; code?: string };
    if (err.code === "23505")
      console.error("✗ That phone number already exists.");
    else console.error("✗ " + (err.message ?? String(e)));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
