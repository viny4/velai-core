// Central config. Bun automatically loads the .env file in this folder.
const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? "postgresql://localhost:5432/velai",
  jwtSecret: env.JWT_SECRET ?? "velai-dev-secret",
  adminKey: env.ADMIN_KEY ?? "village-admin-dev",
  // Comma-separated list of allowed frontend origins.
  corsOrigins: (env.CORS_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Google OAuth client id. Empty = Google login is disabled (phone+PIN only).
  googleClientId: env.GOOGLE_CLIENT_ID ?? "",
  // Gemini (Google AI) — powers voice parsing, embeddings & moderation.
  // Empty = AI features degrade gracefully and the app still works.
  geminiApiKey: env.GEMINI_API_KEY ?? "",
  geminiModel: env.GEMINI_MODEL ?? "gemini-2.5-flash",
  // Translation runs constantly (every job post, every backfill row), so it
  // uses the lite model — 3× the free-tier RPM of gemini-2.5-flash.
  geminiTranslateModel: env.GEMINI_TRANSLATE_MODEL ?? "gemini-2.5-flash-lite",
  geminiEmbedModel: env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001",
  // Web Push (VAPID). Empty public key disables push notifications gracefully.
  vapidPublic: env.VAPID_PUBLIC ?? "",
  vapidPrivate: env.VAPID_PRIVATE ?? "",
  vapidContact: env.VAPID_CONTACT ?? "mailto:hello@velai.app",
  // Used by push payloads as the click-through URL base.
  publicAppUrl: env.PUBLIC_APP_URL ?? "http://localhost:5173",
};
