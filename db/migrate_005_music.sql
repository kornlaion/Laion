-- Music-led clips: lyric timing (speech-to-text on the excerpt). Safe to re-run.
-- 0.006 USD per audio minute for whisper-1 (verify on OpenAI's pricing page); a 30-60 s excerpt is below 0.01 USD, seeded at 0.01 per call.
insert into provider_rates (provider, model, unit, price_usd, valid_from) values
  ('openai-transcribe', 'whisper-1', 'call', 0.01, current_date)
on conflict do nothing;
