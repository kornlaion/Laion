import { renderVideo } from '../render/render.mjs';
import { renderZen } from '../render/zen.mjs';
import { renderMusic, planMusicTimeline } from '../render/music.mjs';
// Internal "provider": the ffmpeg renderer, routed through the Gateway so it has gates, caps and a ledger.
// Inputs are R2 keys (never raw bytes) so the audited params stay small.
async function loadAlign(storage, key) {
  if (!key) return undefined;
  try { const b = await storage.get(key); return b ? JSON.parse(b.toString('utf8')) : undefined; } catch { return undefined; }   // missing or broken timing -> estimated subtitles
}

export function createRenderAdapter({ storage }) {
  return {
    unit: 'second',
    model: () => 'ffmpeg',
    // rough Thai speech rate; ledger estimate only (multi-scene adds a few seconds per scene for pauses and fades)
    units: (p) => (p.music ? Math.ceil(p.music.bounds.at(-1)) + p.scenes.length + 3 : p.scenes
      ? Math.ceil(p.scenes.reduce((a, s) => a + [...s.text].length, 0) / 13) + p.scenes.length * 2 + 3
      : Math.ceil([...String(p.text ?? '')].length / 13) + 1),
    async call(p) {
      if (!storage) throw new Error('storage_not_configured');
      if (p.music) {                                    // music-led: the owner's own song is the soundtrack, no voice-over
        const [song, ...loaded] = await Promise.all([storage.get(p.music.songKey), ...p.scenes.map(async (sc) => ({ image: await storage.get(sc.imageKey), clip: sc.clipKey ? await storage.get(sc.clipKey) : undefined }))]);
        if (!song || loaded.some((x) => !x.image)) throw new Error('input_missing');
        if (p.scenes.some((sc, i) => sc.clipKey && !loaded[i].clip)) throw new Error('clip_missing');
        const { video, seconds } = await renderMusic({ song, start: p.music.start, bounds: p.music.bounds, scenes: loaded, lines: p.music.lines });
        return { video, seconds, externalId: null };
      }
      if (p.scenes) {
        const loaded = await Promise.all(p.scenes.map(async (sc) => ({ image: await storage.get(sc.imageKey), audio: await storage.get(sc.audioKey), text: sc.text, clip: sc.clipKey ? await storage.get(sc.clipKey) : undefined, align: await loadAlign(storage, sc.alignKey) })));
        if (p.scenes.some((sc, i) => sc.clipKey && !loaded[i].clip)) throw new Error('clip_missing');
        if (loaded.some((x) => !x.image || !x.audio)) throw new Error('input_missing');
        const { video, seconds } = await renderZen({ scenes: loaded, title: process.env.SHOW_TITLE === '1' ? p.title : undefined });   // opening title is off by default (set SHOW_TITLE=1 to bring it back)
        return { video, seconds, externalId: null };
      }
      const [image, audio] = await Promise.all([storage.get(p.imageKey), storage.get(p.audioKey)]);
      if (!image || !audio) throw new Error('input_missing');
      const { video, seconds } = await renderVideo({ image, audio, text: p.text });
      return { video, seconds, externalId: null };
    },
  };
}
