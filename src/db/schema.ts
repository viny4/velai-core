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
  name_ta    text,
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

-- Worker / employer photo gallery — past-work images they upload to build
-- trust. Owners view this from a job detail when an applicant interests them.
-- Images are stored as data URLs to keep deployment simple (no separate
-- blob store needed); the frontend resizes to ~600x600 before uploading.
create table if not exists work_photos (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  image_url  text not null,
  caption    text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists work_photos_user_idx on work_photos(user_id, created_at desc);

-- Observability event log. Every API call, every Gemini call, every agent
-- turn, every push, every WS connect is one row here.
-- kind examples: 'api', 'gemini', 'agent_turn', 'agent_tool', 'push', 'ws'
create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  ts          timestamptz not null default now(),
  kind        text not null,
  actor_id    uuid references profiles(id) on delete set null,
  request_id  text,
  duration_ms int,
  status      text not null default 'ok' check (status in ('ok','error','warn')),
  message     text,
  meta        jsonb not null default '{}'::jsonb,
  error       text
);
create index if not exists events_ts_idx       on events(ts desc);
create index if not exists events_kind_ts_idx  on events(kind, ts desc);
create index if not exists events_actor_ts_idx on events(actor_id, ts desc);

-- Idempotent upgrades for databases created before location existed.
alter table profiles add column if not exists pincode text;
alter table profiles add column if not exists lat double precision;
alter table profiles add column if not exists lng double precision;
alter table jobs add column if not exists pincode text;
alter table jobs add column if not exists lat double precision;
alter table jobs add column if not exists lng double precision;
alter table jobs add column if not exists embedding vector(768);

-- Bilingual content: every user-typed field stored in both scripts so the
-- frontend can render the language the user has toggled on (see lib/i18n.ts).
alter table jobs     add column if not exists title_ta       text;
alter table jobs     add column if not exists title_en       text;
alter table jobs     add column if not exists description_ta text;
alter table jobs     add column if not exists description_en text;
alter table jobs     add column if not exists village_ta     text;
alter table jobs     add column if not exists village_en     text;
alter table profiles add column if not exists full_name_ta   text;
alter table profiles add column if not exists full_name_en   text;
alter table profiles add column if not exists village_ta     text;
alter table profiles add column if not exists village_en     text;
alter table districts add column if not exists name_ta       text;

-- Seed the Tamil names for the 38 Tamil Nadu districts. Idempotent — only
-- fills rows where name_ta is null so we don't fight human corrections.
update districts set name_ta = v.ta from (values
  ('ariyalur','அரியலூர்'), ('chengalpattu','செங்கல்பட்டு'),
  ('chennai','சென்னை'), ('coimbatore','கோயம்புத்தூர்'),
  ('cuddalore','கடலூர்'), ('dharmapuri','தர்மபுரி'),
  ('dindigul','திண்டுக்கல்'), ('erode','ஈரோடு'),
  ('kallakurichi','கள்ளக்குறிச்சி'), ('kanchipuram','காஞ்சிபுரம்'),
  ('kanyakumari','கன்னியாகுமரி'), ('karur','கரூர்'),
  ('krishnagiri','கிருஷ்ணகிரி'), ('madurai','மதுரை'),
  ('mayiladuthurai','மயிலாடுதுறை'), ('nagapattinam','நாகப்பட்டினம்'),
  ('namakkal','நாமக்கல்'), ('nilgiris','நீலகிரி'),
  ('perambalur','பெரம்பலூர்'), ('pudukkottai','புதுக்கோட்டை'),
  ('ramanathapuram','ராமநாதபுரம்'), ('ranipet','ராணிப்பேட்டை'),
  ('salem','சேலம்'), ('sivagangai','சிவகங்கை'),
  ('tenkasi','தென்காசி'), ('thanjavur','தஞ்சாவூர்'),
  ('theni','தேனி'), ('thoothukudi','தூத்துக்குடி'),
  ('tiruchirappalli','திருச்சிராப்பள்ளி'),
  ('tirunelveli','திருநெல்வேலி'), ('tirupathur','திருப்பத்தூர்'),
  ('tiruppur','திருப்பூர்'), ('tiruvallur','திருவள்ளூர்'),
  ('tiruvannamalai','திருவண்ணாமலை'), ('tiruvarur','திருவாரூர்'),
  ('vellore','வேலூர்'), ('viluppuram','விழுப்புரம்'),
  ('virudhunagar','விருதுநகர்')
) as v(slug, ta)
where districts.slug = v.slug and districts.name_ta is null;

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
