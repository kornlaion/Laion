-- The 5 channels. Safe to re-run.
insert into channels (id, name, lane, daily_cap_thb, soft_launch) values
  ('love',       'Love & Happiness',        'A', 300, false),
  ('mindbody',   'Mind Body & Wellbeing',   'D', 150, true),
  ('energy-ai',  'Energy EV + AI Tech',     'C', 300, false),
  ('healthtech', 'HealthTech & Longevity',  'D', 150, true),
  ('pet',        'LAION UNIVERSE (IP Character + Weekly Horoscope)',      'B', 300, false)
on conflict (id) do nothing;
