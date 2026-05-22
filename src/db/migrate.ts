/**
 * Migration: drops the old schema-per-district structure (if present) and
 * creates the single-schema model. Idempotent.
 * Run with:  bun run migrate
 */
import { pool } from "./pool";
import { SCHEMA_DDL } from "./schema";

async function migrate() {
  // Remove the prototype's per-district schemas, if this DB still has them.
  const old = await pool.query<{ schema_name: string }>(
    `select schema_name from information_schema.schemata
     where schema_name = 'shared' or schema_name like 'tenant_%'`,
  );
  for (const row of old.rows) {
    await pool.query(`drop schema if exists "${row.schema_name}" cascade`);
  }
  if (old.rowCount) console.log(`✓ removed ${old.rowCount} old district schema(s)`);

  await pool.query(SCHEMA_DDL);
  console.log("✓ schema ready: districts, profiles, jobs, job_responses");
  await pool.end();
}

migrate().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
