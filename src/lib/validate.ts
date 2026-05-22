const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value looks like a UUID — used to reject bad :id params
 *  before they reach Postgres (which would otherwise throw a 500). */
export function isUuid(v: unknown): boolean {
  return typeof v === "string" && UUID_RE.test(v);
}
