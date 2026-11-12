-- Planner on OpenAI (script + scene design). 0.02 USD per call is conservative:
-- about 2k input + 1.5k output tokens at gpt-4.1 list prices (2 / 8 USD per MTok) is roughly 0.016 USD.
-- If you set OPENAI_PLAN_MODEL to another model, add a row with that model name. Safe to re-run.
insert into provider_rates (provider, model, unit, price_usd, valid_from) values
  ('openai-text', 'gpt-4.1', 'call', 0.02, current_date)
on conflict do nothing;
