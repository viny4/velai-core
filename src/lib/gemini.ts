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
          outputDimensionality: 768,
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

/** Low-level JSON completion. Returns parsed JSON, or null on any failure.
 *  Honours a single 429 retry using the server's suggested delay. */
async function generateJson(
  prompt: string,
  responseSchema: object,
  model: string = config.geminiModel,
): Promise<any | null> {
  if (!geminiAvailable()) return null;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.2,
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `${BASE}/models/${model}:generateContent?key=${config.geminiApiKey}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
      );
      if (res.status === 429 && attempt === 0) {
        // Parse the server's retryDelay (e.g. "23s") and sleep that long.
        const txt = await res.text();
        const m = txt.match(/"retryDelay":\s*"(\d+)s"/);
        const wait = (m ? Math.min(30, Number(m[1])) : 25) * 1000;
        await new Promise((r) => setTimeout(r, wait + 500));
        continue;
      }
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
  return null;
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

/**
 * Translate prose between Tamil and English. Returns the translated text only
 * (no quotes, no commentary). Returns null on failure so the caller can fall
 * back to the original string.
 */
export async function translate(
  text: string,
  target: "ta" | "en",
): Promise<string | null> {
  const clean = text.trim();
  if (!clean) return clean;
  const targetName = target === "ta" ? "Tamil" : "English";
  const prompt = `Translate the following text to ${targetName} for a rural daily-wage job marketplace in Tamil Nadu.

- Keep it natural and concise — how a real person would say it, not literal.
- Keep numbers, dates and units unchanged.
- Do NOT translate names of people or villages — leave them as-is.
- Output ONLY the translation, no quotes, no notes, no labels.

Text:
${clean.slice(0, 4000)}`;

  const result = await generateJson(
    prompt,
    {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    config.geminiTranslateModel,
  );
  return typeof result?.text === "string" ? result.text.trim() : null;
}

/**
 * Transliterate a name or place between Tamil and Roman script.
 * Transliteration preserves the SOUND ("முருகன்" ↔ "Murugan"). It is NOT
 * translation. Returns null on failure.
 */
export async function transliterate(
  text: string,
  target: "ta" | "en",
): Promise<string | null> {
  const clean = text.trim();
  if (!clean) return clean;
  const targetScript = target === "ta" ? "Tamil script" : "Roman (English) script";
  const prompt = `Transliterate the following Tamil name or place name into ${targetScript}.

- Preserve the SOUND — do not translate the meaning.
- Use the most common spelling people use today (e.g. "முருகன்" → "Murugan", "சேயூர்" → "Cheyyur", "Lakshmi" → "லட்சுமி").
- If the input is already in the target script, return it unchanged.
- Output ONLY the transliteration, no quotes, no notes.

Text:
${clean.slice(0, 200)}`;

  const result = await generateJson(
    prompt,
    {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    config.geminiTranslateModel,
  );
  return typeof result?.text === "string" ? result.text.trim() : null;
}

// ─── Agent / function-calling ───────────────────────────────────────────────

export interface FunctionDecl {
  name: string;
  description: string;
  parameters: object;
}

export type AgentTurn =
  | { role: "user"; text: string }
  | { role: "model"; text: string }
  | { role: "tool_call"; name: string; args: any }
  | { role: "tool_result"; name: string; result: any };

export type AgentReply =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; args: any };

/** Map our compact turn shape into Gemini's `contents` array. */
function toContents(turns: AgentTurn[]): any[] {
  const out: any[] = [];
  for (const t of turns) {
    if (t.role === "user")
      out.push({ role: "user", parts: [{ text: t.text }] });
    else if (t.role === "model")
      out.push({ role: "model", parts: [{ text: t.text }] });
    else if (t.role === "tool_call")
      out.push({
        role: "model",
        parts: [{ functionCall: { name: t.name, args: t.args } }],
      });
    else if (t.role === "tool_result")
      out.push({
        role: "user",
        parts: [
          { functionResponse: { name: t.name, response: { result: t.result } } },
        ],
      });
  }
  return out;
}

/**
 * One agent turn. Sends history + tool definitions + system prompt to Gemini.
 * Returns either:
 *   - { kind: "text" } — natural-language reply to speak back to the user
 *   - { kind: "tool_call" } — the model wants to call one of our tools
 *
 * The caller (routes/agent.ts) runs the tool, appends a "tool_result" turn,
 * and calls this again to get the final spoken reply.
 */
export async function agentTurn(
  history: AgentTurn[],
  tools: FunctionDecl[],
  systemPrompt: string,
): Promise<AgentReply | null> {
  if (!geminiAvailable()) return null;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: toContents(history),
    tools: [{ functionDeclarations: tools }],
    generationConfig: { temperature: 0.4 },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `${BASE}/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
      );
      if (res.status === 429 && attempt === 0) {
        const txt = await res.text();
        const m = txt.match(/"retryDelay":\s*"(\d+)s"/);
        const wait = (m ? Math.min(30, Number(m[1])) : 25) * 1000;
        await new Promise((r) => setTimeout(r, wait + 500));
        continue;
      }
      if (!res.ok) {
        console.error("Gemini agent failed:", res.status, await res.text());
        return null;
      }
      const data = (await res.json()) as any;
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (p.functionCall)
          return {
            kind: "tool_call",
            name: p.functionCall.name,
            args: p.functionCall.args ?? {},
          };
      }
      const text = parts.map((p: any) => p.text ?? "").join("").trim();
      if (text) return { kind: "text", text };
      return null;
    } catch (e) {
      console.error("Gemini agent error:", e);
      return null;
    }
  }
  return null;
}
