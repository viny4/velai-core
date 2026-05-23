/**
 * Bilingual content storage and serving.
 *
 * Every user-typed field that we want to be language-toggle-aware (job
 * title/description, person name, village) gets stored as TWO columns:
 * `<field>_ta` and `<field>_en`. On insert, whichever script the user typed
 * fills its own column, and Gemini fills the other one.
 *
 * On read, `pickLang(req)` returns "ta" or "en" based on Accept-Language;
 * `pick(row, base, lang)` selects the right column with a sane fallback.
 */
import type { Request } from "express";
import { translate, transliterate } from "./gemini";

/** Any character in the Tamil Unicode block. */
const TAMIL_RE = /[஀-௿]/;

export type Lang = "ta" | "en";

export function detectLang(text: string): Lang {
  return TAMIL_RE.test(text) ? "ta" : "en";
}

/** Read the caller's preferred language from a header (default Tamil). */
export function pickLang(req: Request): Lang {
  const h = String(req.headers["accept-language"] ?? "").toLowerCase();
  if (h.startsWith("en")) return "en";
  return "ta";
}

/**
 * Given user-typed text in either language, return both versions —
 * source language passes through, the other is translated by Gemini.
 * Falls back to the same string on both sides if Gemini is unavailable.
 */
export async function translatePair(text: string): Promise<{ ta: string; en: string }> {
  const clean = (text ?? "").trim();
  if (!clean) return { ta: "", en: "" };
  const src = detectLang(clean);
  const other = src === "ta" ? "en" : "ta";
  const translated = await translate(clean, other);
  if (!translated) return { ta: clean, en: clean };
  return src === "ta"
    ? { ta: clean, en: translated }
    : { ta: translated, en: clean };
}

/** Same as translatePair, but for names + places (sound-preserving). */
export async function transliteratePair(
  text: string,
): Promise<{ ta: string; en: string }> {
  const clean = (text ?? "").trim();
  if (!clean) return { ta: "", en: "" };
  const src = detectLang(clean);
  const other = src === "ta" ? "en" : "ta";
  const t = await transliterate(clean, other);
  if (!t) return { ta: clean, en: clean };
  return src === "ta" ? { ta: clean, en: t } : { ta: t, en: clean };
}

/**
 * Pick the requested-language column from a row, falling back through
 * `<base>_<lang>` → `<base>_<other>` → `<base>` (the original column).
 * Lets old rows without the bilingual columns still render.
 */
export function pick<T extends Record<string, any>>(
  row: T,
  base: string,
  lang: Lang,
): string {
  return (
    row[`${base}_${lang}`] ||
    row[`${base}_${lang === "ta" ? "en" : "ta"}`] ||
    row[base] ||
    ""
  );
}

/**
 * Apply pick() to a row in place: replaces `row.<base>` with the right
 * language's column for every base name given. Useful right before sending
 * the row to the client.
 */
export function localizeRow<T extends Record<string, any>>(
  row: T,
  lang: Lang,
  bases: readonly string[],
): T {
  for (const b of bases) {
    const v = pick(row, b, lang);
    if (v) (row as any)[b] = v;
  }
  return row;
}
