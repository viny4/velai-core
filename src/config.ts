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
};
