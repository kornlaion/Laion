-- Internal render cost estimate (server CPU time), USD per output second. Tune after measuring real usage.
insert into provider_rates (provider, model, unit, price_usd, valid_from) values
  ('render', 'ffmpeg', 'second', 0.0005, current_date)
on conflict do nothing;
