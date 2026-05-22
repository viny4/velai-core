import pg from "pg";
import { config } from "../config";

// Return DATE columns as plain "YYYY-MM-DD" strings (avoids timezone drift
// when a date-only value round-trips through JSON).
pg.types.setTypeParser(1082, (v) => v);

/** One shared connection pool. The app uses a single schema; rows are scoped
 *  by their `district` column, so no per-request search_path juggling. */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});
