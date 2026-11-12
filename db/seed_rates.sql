-- Starter provider_rates. Prices are from provider pages read in Sep-Oct 2026 and MUST be re-checked
-- before use. Image prices are per 1024x1024 image; portrait sizes cost roughly 1.5x, so the
-- values below include that margin. Update by inserting a new row with a later valid_from.
insert into provider_rates (provider, model, unit, price_usd, valid_from) values
  ('openai', 'gpt-image-2:low',    'image', 0.009, current_date),
  ('openai', 'gpt-image-2:medium', 'image', 0.080, current_date),
  ('openai', 'gpt-image-2:high',   'image', 0.317, current_date)
on conflict do nothing;
