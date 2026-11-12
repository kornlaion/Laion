-- ElevenLabs list prices per 1,000 characters (API pricing page, Nov 12 2026). Re-check before relying on them.
-- Your subscription may make real cost lower; the ledger uses list price as the safe upper bound.
insert into provider_rates (provider, model, unit, price_usd, valid_from) values
  ('elevenlabs', 'eleven_v4',               '1k_chars', 0.08, current_date),
  ('elevenlabs', 'eleven_v4_turbo',         '1k_chars', 0.04, current_date),
  ('elevenlabs', 'eleven_v3',               '1k_chars', 0.08, current_date),
  ('elevenlabs', 'eleven_multilingual_v2',  '1k_chars', 0.08, current_date)
on conflict do nothing;
