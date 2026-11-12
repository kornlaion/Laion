-- AI Media Universe: initial schema (PostgreSQL 15+, pgvector)
create extension if not exists vector;

create table channels (
  id            text primary key,              -- 'love','mindbody','energy-ai','healthtech','pet'
  name          text not null,
  lane          text not null check (lane in ('A','B','C','D')),
  daily_cap_thb numeric not null default 0,
  soft_launch   boolean not null default false,
  paused        boolean not null default false
);

create table jobs (
  id               uuid primary key default gen_random_uuid(),
  channel_id       text not null references channels(id),
  grade            text not null check (grade in ('G0','G1','G2','G3','G4')),
  topic            text not null,
  state            text not null default 'planned',
  cap_thb          numeric not null,
  requires_expert  boolean not null default false,
  idempotency_key  text unique not null,
  plan             jsonb,
  created_at       timestamptz not null default now()
);

create table approvals (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs(id),
  gate       text not null check (gate in ('A','B','C','D')),
  user_id    text not null,
  decision   text not null check (decision in ('approve','revise','reject')),
  at         timestamptz not null default now()
);

create table tasks (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references jobs(id),
  provider       text not null,
  action         text not null,
  attempt        int not null default 1,
  status         text not null default 'queued',
  external_op_id text,
  idempotency_key text unique not null
);

-- Single source of truth for spend. Never sum costs in application code.
create table provider_rates (
  provider   text not null,
  model      text not null,
  unit       text not null,                    -- 'image','second','1k_chars'
  price_usd  numeric not null,
  valid_from date not null,
  primary key (provider, model, unit, valid_from)
);

create table ledger (
  id        uuid primary key default gen_random_uuid(),
  task_id   uuid not null references tasks(id),
  provider  text not null,
  units     numeric not null,
  cost_usd  numeric not null,
  cost_thb  numeric not null,
  at        timestamptz not null default now()
);

create table assets (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid references jobs(id),
  r2_key        text not null,
  kind          text not null,
  ai_generated  boolean not null default true,
  created_at    timestamptz not null default now()
);

create table rights (
  id        uuid primary key default gen_random_uuid(),
  asset_id  uuid references assets(id),
  owner     text not null,
  license   text not null,
  expires   date
);

create table research_packs (
  id         uuid primary key default gen_random_uuid(),
  channel_id text references channels(id),
  title      text not null,
  risk_flags text[] default '{}',
  expires_at date,
  reviewer   text
);
create table sources (
  id     uuid primary key default gen_random_uuid(),
  url    text not null,
  title  text,
  fetched_at timestamptz not null default now()
);
create table claims (
  id         uuid primary key default gen_random_uuid(),
  pack_id    uuid not null references research_packs(id),
  text       text not null,
  source_id  uuid references sources(id),
  confidence text check (confidence in ('low','medium','high'))
);
create table opportunities (
  id         uuid primary key default gen_random_uuid(),
  channel_id text references channels(id),
  idea       text not null,
  score      numeric,
  created_at timestamptz not null default now()
);
create table expert_reviews (
  id        uuid primary key default gen_random_uuid(),
  pack_id   uuid not null references research_packs(id),
  reviewer  text not null,
  decision  text not null check (decision in ('approve','revise','reject')),
  at        timestamptz not null default now()
);

create table posts (
  id         uuid primary key default gen_random_uuid(),
  channel_id text not null references channels(id),
  platform   text not null,
  url        text,
  embedding  vector(1536),                     -- originality gate: compare with last 30 posts
  metrics    jsonb default '{}',
  posted_at  timestamptz not null default now()
);

create table kill_switch (
  scope text not null check (scope in ('system','channel','provider')),
  key   text not null default '*',
  on_at timestamptz not null default now(),
  primary key (scope, key)
);

create table audit_log (
  id           bigserial primary key,
  actor        text not null,
  action       text not null,
  payload_hash text,
  at           timestamptz not null default now()
);
