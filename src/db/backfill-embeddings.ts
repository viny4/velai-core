/**
 * Backfill vector embeddings for jobs that don't have one yet.
 * Run with:  bun run backfill-embeddings   (requires GEMINI_API_KEY)
 */
import { pool } from "./pool";
import { geminiAvailable } from "../lib/gemini";
import { embedAndStoreJob } from "../lib/embeddings";

async function backfill() {
  if (!geminiAvailable()) {
    console.error("GEMINI_API_KEY is not set — cannot create embeddings.");
    process.exit(1);
  }

  const r = await pool.query<{
    id: string;
    title: string;
    description: string;
    job_type: string;
    village: string;
  }>(
    `select id, title, description, job_type, village
     from jobs where embedding is null`,
  );
  console.log(`Embedding ${r.rowCount} job(s)...`);

  let done = 0;
  for (const job of r.rows) {
    await embedAndStoreJob(job.id, job);
    done++;
    console.log(`  ✓ ${done}/${r.rowCount}  ${job.title}`);
  }
  console.log("✓ Backfill complete.");
  await pool.end();
}

backfill().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
