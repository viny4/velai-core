import { pool } from "./pool";
import { ApiError } from "../lib/errors";

export interface District {
  id: number;
  name: string;
  slug: string;
}

/** "Madurai" -> "madurai", "The Nilgiris" -> "the_nilgiris" */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Public list of districts for the sign-up dropdown.
 *  Returns Tamil names when `lang === "ta"`. */
export async function listDistricts(
  lang: "ta" | "en" = "en",
): Promise<{ slug: string; name: string }[]> {
  const r = await pool.query<{ slug: string; name: string; name_ta: string | null }>(
    `select slug, name, name_ta from districts order by name`,
  );
  return r.rows.map((d) => ({
    slug: d.slug,
    name: lang === "ta" ? d.name_ta || d.name : d.name,
  }));
}

/** Resolve a district by slug; throws if it does not exist. */
export async function getDistrict(slug: string): Promise<District> {
  const r = await pool.query<District>(
    `select id, name, slug from districts where slug = $1`,
    [slug],
  );
  if (!r.rowCount) throw new ApiError(400, "Please select a valid district");
  return r.rows[0]!;
}

/** Add a district (idempotent). Onboarding a region = inserting one row. */
export async function addDistrict(name: string): Promise<District> {
  const slug = slugify(name);
  if (!slug) throw new ApiError(400, "Invalid district name");
  const r = await pool.query<District>(
    `insert into districts (name, slug) values ($1, $2)
     on conflict (slug) do update set name = excluded.name
     returning id, name, slug`,
    [name, slug],
  );
  return r.rows[0]!;
}
