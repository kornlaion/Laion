-- Needed so "latest asset of a job" is well defined. Safe to re-run.
alter table assets add column if not exists created_at timestamptz not null default now();
