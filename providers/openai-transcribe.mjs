import { cutAudio } from '../render/music.mjs';
// Speech-to-text with word timestamps (OpenAI whisper-1), used ONLY to time the owner's own lyrics against the singing.
// Inputs are an R2 key and a time range, never raw bytes. Live request shape UNVERIFIED until the first real call;
// accuracy on sung Thai is unknown: the lyrics matcher (ops/lyrics.mjs) reports a confidence and the bot says so.
export function createTranscribeAdapter({ storage, apiKey, model = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'whisper-1', fetchImpl = fetch } = {}) {
  return {
    unit: 'call',
    model: () => model,
    units: () => 1,
    async call(p) {
      apiKey ??= process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY missing');
      if (!storage) throw new Error('storage_not_configured');
      const song = await storage.get(p.songKey);
      if (!song) throw new Error('song_missing');
      const clip = await cutAudio(song, { start: p.start, dur: p.duration, mono: true, bitrate: '64k' });
      const form = new FormData();
      form.append('file', new Blob([clip], { type: 'audio/mpeg' }), 'excerpt.mp3');
      form.append('model', model);
      form.append('language', 'th');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      const res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form });
      if (!res.ok) {
        let detail = '';
        try { detail = String((await res.json())?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 140); } catch { /* no body */ }
        throw new Error(`openai_transcribe_${res.status}${detail ? `: ${detail}` : ''}`);
      }
      const json = await res.json();
      const words = (json.words ?? []).map((w) => ({ word: String(w.word ?? ''), start: Number(w.start), end: Number(w.end) })).filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end));
      return { words, text: String(json.text ?? ''), externalId: null };
    },
  };
}
