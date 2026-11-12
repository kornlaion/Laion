// ElevenLabs text-to-speech adapter. Endpoint/body from the public API reference (Nov 2026).
// UNVERIFIED live: whether the model in ELEVENLABS_MODEL accepts Thai on this endpoint.
// Price unit is '1k_chars' (provider_rates), billed at list price per 1,000 characters.
export function createElevenLabsAdapter({
  apiKey = process.env.ELEVENLABS_API_KEY,
  voiceId = process.env.ELEVENLABS_VOICE_ID,                 // default voice (used when no gender is given)
  voices = { female: process.env.ELEVENLABS_VOICE_FEMALE, male: process.env.ELEVENLABS_VOICE_MALE },
  model = process.env.ELEVENLABS_MODEL ?? 'eleven_v4',
  languageCode = process.env.ELEVENLABS_LANG || undefined,   // optional ISO 639-1, e.g. 'th'
  fetchImpl = fetch,
  timestamps = process.env.ELEVENLABS_TIMESTAMPS !== '0',     // per-character timing for exact subtitle sync (set 0 to disable)
} = {}) {
  return {
    unit: '1k_chars',
    model: () => model,
    units: (p) => [...String(p.text ?? '')].length / 1000,
    async call(p) {
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY missing');
      const voice = (p.voice && voices[p.voice]) || voiceId;
      if (!voice) throw new Error('voice id missing');
      const body = JSON.stringify({
        text: p.text, model_id: model,
        ...(languageCode ? { language_code: languageCode } : {}),
        ...(p.previous_text ? { previous_text: p.previous_text } : {}),   // neighbouring scenes keep the delivery consistent
        ...(p.next_text ? { next_text: p.next_text } : {}),
      });
      const post = (path) => fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}${path}?output_format=mp3_44100_128`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'xi-api-key': apiKey }, body });
      let audio, alignment = null, res;
      if (p.timestamps && timestamps) {
        // Same price per character. A failed or odd reply falls back to the plain endpoint, so voice still works without timing.
        try {
          res = await post('/with-timestamps');
          if (res.ok) {
            const j = await res.json();
            const a = j.alignment ?? j.normalized_alignment;
            audio = Buffer.from(String(j.audio_base64 ?? ''), 'base64');
            if (a?.characters?.length && a.character_start_times_seconds?.length === a.characters.length) {
              alignment = { characters: a.characters, starts: a.character_start_times_seconds, ends: a.character_end_times_seconds };
            }
          }
        } catch { audio = undefined; }
      }
      if (!audio?.length) {
        res = await post('');
        if (!res.ok) throw new Error(`elevenlabs_${res.status}`);   // body not logged
        audio = Buffer.from(await res.arrayBuffer());
        alignment = null;
      }
      if (!audio.length) throw new Error('elevenlabs_empty');
      return { audio, alignment, externalId: res.headers?.get?.('request-id') ?? null };
    },
  };
}
