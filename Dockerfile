# Velai API — runs on the Bun runtime.
FROM oven/bun:1

WORKDIR /app

# Install dependencies first (better build caching).
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# App source.
COPY . .

ENV NODE_ENV=production

# The app reads PORT from the environment (the host injects it).
CMD ["bun", "src/index.ts"]
