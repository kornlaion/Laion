-- Plan (script + image prompt) stored on the job, and a conservative per-call rate for the script writer.
-- 0.02 USD per call covers roughly 2k input + 1.5k output tokens at Sonnet 5.5 list prices (2 / 10 USD per MTok). Safe to re-run.
alter table jobs add column if not exists plan jsonb;
insert into provider_rates (provider, model, unit, price_usd, valid_from) values
  ('anthropic', 'claude-sonnet-5-5', 'call', 0.02, current_date)
on conflict do nothing;
