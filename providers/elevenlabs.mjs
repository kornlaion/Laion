// ElevenLabs text-to-speech adapter. Endpoint/body from the public API reference (Nov 2026).
// UNVERIFIED live: whether the model in ELEVENLABS_MODEL accepts Thai on this endpoint.
// Price unit is '1k_chars' (provider_rates), billed at list price per 1,000 characters.
export function createElevenLabsAdapter({
  apiKey = process.env.ELEVENLABS_API_KEY,
  voiceId = process.env.ELEVENLABS_VOICE_ID,
  model = process.env.ELEVENLABS_MODEL ?? 'eleven_v4',
  languageCode = process.env.ELEVENLABS_LANG || undefined,   // optional ISO 639-1, e.g. 'th'
  fetchImpl = fetch,
} = {}) {
  return {
    unit: '1k_chars',
    model: () => model,
    units: (p) => [...String(p.text ?? '')].length / 1000,
    async call(p) {
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY missing');
      if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID missing');
      const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': apiKey },
        body: JSON.stringify({ text: p.text, model_id: model, ...(languageCode ? { language_code: languageCode } : {}) }),
      });
      if (!res.ok) throw new Error(`elevenlabs_${res.status}`);   // body not logged
      const audio = Buffer.from(await res.arrayBuffer());
      if (!audio.length) throw new Error('elevenlabs_empty');
      return { audio, externalId: res.headers?.get?.('request-id') ?? null };
    },
  };
}
