# velai-core

Backend API for **Velai** — a Tamil-first daily-wage job marketplace for
Tamil Nadu villages. Workers and employers post and find nearby short-term
jobs and connect directly, with no middlemen.

## Stack

- Bun + Express 5 + TypeScript
- PostgreSQL — single schema, row-level district scoping, location-ready
- Auth — JWT; phone + 6-digit PIN, and Google sign-in

## Setup

```bash
bun install
cp .env.example .env      # set DATABASE_URL, JWT_SECRET, GOOGLE_CLIENT_ID
bun run setup             # create schema + seed sample data
bun run dev               # API on http://localhost:4000
```

## Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Start the API with autoreload |
| `bun run migrate` | Create/upgrade the database schema |
| `bun run seed` | Insert districts + sample data |
| `bun run setup` | migrate + seed |
| `bun run manage` | Data management CLI (`bun run manage` for help) |

## API

`/api/health` · `/api/auth/*` · `/api/jobs` · `/api/responses` · `/api/districts`
