-- Daily topic research: ideas per channel, plus the research rate. Safe to re-run.
create table if not exists research_ideas (
  id         uuid primary key default gen_random_uuid(),
  channel_id text not null references channels(id),
  run_date   date not null,
  rank       int  not null,
  title      text not null,
  hook       text not null,
  sources    jsonb not null default '[]',
  status     text not null default 'new' check (status in ('new','picked','skipped')),
  created_at timestamptz not null default now()
);
create index if not exists research_ideas_lookup on research_ideas (channel_id, run_date);

-- 0.08 USD per channel run covers a few web searches plus about 6k tokens (conservative estimate; check real cost in OpenAI Usage).
insert into provider_rates (provider, model, unit, price_usd, valid_from) values
  ('openai-research', 'gpt-4.1', 'call', 0.08, current_date)
on conflict do nothing;
