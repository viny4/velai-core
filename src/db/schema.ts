/**
 * Single-schema data model.
 *
 * The prototype used one Postgres schema per district. The product now uses
 * ONE schema with a `district` column on each row — because the core feature,
 * "nearby jobs", crosses district borders. Scoping is row-level: a normal
 * WHERE clause (and, later, a location radius), not a separate schema.
 *
 * `lat` / `lng` are stored now (nullable) so location matching is a pure query
 * change later — no migration needed.
 */

export const JOB_TYPES = [
  "farming",
  "cattle_care",
  "housework",
  "coconut_climbing",
  "tractor_driving",
  "painting",
  "elderly_care",
  "cooking",
  "construction",
  "other",
] as const;

const JOB_TYPE_CHECK = JOB_TYPES.map((t) => `'${t}'`).join(",");

export const SCHEMA_DDL = `
create table if not exists districts (
  id         serial primary key,
  name       text not null,
  slug       text not null unique,
  state      text not null default 'Tamil Nadu',
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null unique,
  full_name   text not null,
  pin_hash    text,
  email       text unique,
  google_sub  text unique,
  avatar_url  text,
  role        text not null default 'both' check (role in ('worker','employer','both')),
  district    text not null references districts(slug),
  village     text not null,
  lat         double precision,
  lng         double precision,
  skills      text[] not null default '{}',
  created_at  timestamptz not null default now()
);

create table if not exists jobs (
  id             uuid primary key default gen_random_uuid(),
  posted_by      uuid not null references profiles(id) on delete cascade,
  title          text not null,
  description    text not null default '',
  job_type       text not null check (job_type in (${JOB_TYPE_CHECK})),
  workers_needed int not null default 1 check (workers_needed > 0),
  wage_amount    numeric not null check (wage_amount >= 0),
  wage_type      text not null default 'per_day' check (wage_type in ('per_day','per_job')),
  job_date       date not null,
  district       text not null references districts(slug),
  village        text not null,
  lat            double precision,
  lng            double precision,
  status         text not null default 'open' check (status in ('open','filled','completed','cancelled')),
  created_at     timestamptz not null default now()
);

create index if not exists jobs_feed_idx on jobs(district, status, created_at desc);
create index if not exists jobs_posted_by_idx on jobs(posted_by);

create table if not exists job_responses (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs(id) on delete cascade,
  worker_id   uuid not null references profiles(id) on delete cascade,
  status      text not null default 'interested' check (status in ('interested','accepted','rejected')),
  created_at  timestamptz not null default now(),
  unique (job_id, worker_id)
);
`;
