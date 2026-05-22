/**
 * Gemini (Google AI) client — the AI engine of the project.
 * Used for: text embeddings (semantic search & recommendations),
 * voice-transcript → structured job extraction, and content moderation.
 *
 * Every function degrades gracefully: if no API key is configured (or a call
 * fails) it returns null, and the caller falls back to a non-AI path.
 */
import { config } from "../config";
import { JOB_TYPES } from "../db/schema";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export function geminiAvailable(): boolean {
  return config.geminiApiKey.length > 0;
}

/** Embed text into a 768-dimension vector (Gemini embedding model). */
export async function embedText(text: string): Promise<number[] | null> {
  if (!geminiAvailable()) return null;
  const clean = text.trim().slice(0, 8000);
  if (!clean) return null;
  try {
    const res = await fetch(
      `${BASE}/models/${config.geminiEmbedModel}:embedContent?key=${config.geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${config.geminiEmbedModel}`,
          content: { parts: [{ text: clean }] },
        }),
      },
    );
    if (!res.ok) {
      console.error("Gemini embed failed:", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as any;
    const values = data?.embedding?.values;
    return Array.isArray(values) ? values : null;
  } catch (e) {
    console.error("Gemini embed error:", e);
    return null;
  }
}

/** Low-level JSON completion. Returns parsed JSON, or null on any failure. */
async function generateJson(
  prompt: string,
  responseSchema: object,
): Promise<any | null> {
  if (!geminiAvailable()) return null;
  try {
    const res = await fetch(
      `${BASE}/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema,
            temperature: 0.2,
          },
        }),
      },
    );
    if (!res.ok) {
      console.error("Gemini generate failed:", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? JSON.parse(text) : null;
  } catch (e) {
    console.error("Gemini generate error:", e);
    return null;
  }
}

export interface ExtractedJob {
  job_type?: string;
  title?: string;
  description?: string;
  wage_amount?: number;
  wage_type?: string;
  workers_needed?: number;
  job_date?: string;
}

/**
 * Voice job posting: turn a worker's spoken (Tamil) transcript into a
 * structured job draft via the LLM — named-entity / information extraction.
 */
export async function extractJob(
  transcript: string,
): Promise<ExtractedJob | null> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You extract a daily-wage job posting from a rural worker's spoken text (usually Tamil) for a Tamil Nadu village job app.

Today's date is ${today}.

Spoken text:
"""${transcript.slice(0, 2000)}"""

Extract these fields:
- job_type: one of ${JOB_TYPES.join(", ")}
- title: a short clear job title (keep it in Tamil if the input is Tamil)
- description: any extra detail mentioned
- wage_amount: the pay as a number (rupees), if mentioned
- wage_type: "per_day" or "per_job"
- workers_needed: how many people, as an integer
- job_date: the work date as YYYY-MM-DD. Resolve relative dates ("நாளை" = tomorrow, "இன்று" = today) from today's date.

Only include fields that are clearly present. Always include job_type and title.`;

  const schema = {
    type: "object",
    properties: {
      job_type: { type: "string", enum: [...JOB_TYPES] },
      title: { type: "string" },
      description: { type: "string" },
      wage_amount: { type: "number" },
      wage_type: { type: "string", enum: ["per_day", "per_job"] },
      workers_needed: { type: "integer" },
      job_date: { type: "string" },
    },
    required: ["job_type", "title"],
  };
  return generateJson(prompt, schema);
}

export interface Moderation {
  ok: boolean;
  reason: string;
}

/**
 * Content moderation: check a job post is a genuine, appropriate daily-wage
 * job — not spam, a scam, abusive, or unrelated content.
 */
export async function moderateJob(
  title: string,
  description: string,
): Promise<Moderation | null> {
  const prompt = `You moderate job posts on a rural daily-wage job app for Tamil Nadu villages.
Decide if this post is a GENUINE, appropriate daily-wage job.
Reject only if it is clearly: spam, a scam, sexual/abusive, hateful, or not a real job at all.
Be lenient — ordinary village jobs (farming, cattle, cooking, painting, driving, care work, etc.) are fine.

Title: "${title}"
Description: "${description}"

Return ok=true if acceptable, or ok=false with a short reason (in the post's language).`;

  const schema = {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      reason: { type: "string" },
    },
    required: ["ok"],
  };
  const result = await generateJson(prompt, schema);
  if (!result) return null;
  return { ok: result.ok !== false, reason: result.reason ?? "" };
}
