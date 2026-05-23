/**
 * Single-schema data model with pincode + GPS location.
 *
 * Location model:
 *  - `pincodes` is a reference table (Tamil Nadu pincode -> district + lat/lng).
 *  - profiles & jobs carry `pincode`, `lat`, `lng`. GPS fills lat/lng precisely;
 *    if GPS is denied, the pincode's centroid is used.
 *  - "Nearby" = haversine distance between two lat/lng pairs (no PostGIS needed).
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
create extension if not exists vector;

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
  pincode     text,
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
  pincode        text,
  lat            double precision,
  lng            double precision,
  embedding      vector(768),
  status         text not null default 'open' check (status in ('open','filled','completed','cancelled')),
  created_at     timestamptz not null default now()
);

create index if not exists jobs_feed_idx on jobs(status, created_at desc);
create index if not exists jobs_posted_by_idx on jobs(posted_by);

create table if not exists job_responses (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs(id) on delete cascade,
  worker_id   uuid not null references profiles(id) on delete cascade,
  status      text not null default 'interested' check (status in ('interested','accepted','rejected')),
  created_at  timestamptz not null default now(),
  unique (job_id, worker_id)
);

create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references jobs(id) on delete cascade,
  worker_id       uuid not null references profiles(id) on delete cascade,
  employer_id     uuid not null references profiles(id) on delete cascade,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (job_id, worker_id)
);

create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id       uuid not null references profiles(id) on delete cascade,
  body            text not null,
  created_at      timestamptz not null default now()
);

create index if not exists messages_conv_idx on messages(conversation_id, created_at);

-- Web Push subscriptions. One user can have several (phone + laptop).
create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions(user_id);

-- Two-way ratings, scoped to one job. The 'rater' rates the 'ratee' 1-5 stars
-- after the job is marked completed. Unique per (job, rater) prevents spam.
create table if not exists ratings (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs(id) on delete cascade,
  rater_id   uuid not null references profiles(id) on delete cascade,
  ratee_id   uuid not null references profiles(id) on delete cascade,
  stars      int  not null check (stars between 1 and 5),
  comment    text not null default '',
  created_at timestamptz not null default now(),
  unique (job_id, rater_id)
);
create index if not exists ratings_ratee_idx on ratings(ratee_id);

-- In-app pilot feedback ("Tell us what's wrong / what's missing").
create table if not exists feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles(id) on delete set null,
  body       text not null,
  page       text not null default '',
  created_at timestamptz not null default now()
);

-- Idempotent upgrades for databases created before location existed.
alter table profiles add column if not exists pincode text;
alter table profiles add column if not exists lat double precision;
alter table profiles add column if not exists lng double precision;
alter table jobs add column if not exists pincode text;
alter table jobs add column if not exists lat double precision;
alter table jobs add column if not exists lng double precision;
alter table jobs add column if not exists embedding vector(768);

-- Vector index for fast semantic (nearest-neighbour) search.
create index if not exists jobs_embedding_idx
  on jobs using hnsw (embedding vector_cosine_ops);
`;

/**
 * Haversine distance (km) between a fixed point ($1 = lat, $2 = lng) and a
 * row's lat/lng columns. Returns NULL when the row has no coordinates.
 */
export const DISTANCE_KM_SQL = `
  case when j.lat is null or j.lng is null then null else
    6371 * acos(least(1, greatest(-1,
      cos(radians($LAT)) * cos(radians(j.lat)) * cos(radians(j.lng) - radians($LNG))
      + sin(radians($LAT)) * sin(radians(j.lat))
    )))
  end`;
