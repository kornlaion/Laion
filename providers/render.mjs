import { renderVideo } from '../render/render.mjs';
// Internal "provider": the ffmpeg renderer, routed through the Gateway so it has gates, caps and a ledger.
// Inputs are R2 keys (never raw bytes) so the audited params stay small.
export function createRenderAdapter({ storage }) {
  return {
    unit: 'second',
    model: () => 'ffmpeg',
    units: (p) => Math.ceil([...String(p.text ?? '')].length / 13) + 1,      // rough Thai speech rate; ledger estimate only
    async call(p) {
      if (!storage) throw new Error('storage_not_configured');
      const [image, audio] = await Promise.all([storage.get(p.imageKey), storage.get(p.audioKey)]);
      if (!image || !audio) throw new Error('input_missing');
      const { video, seconds } = await renderVideo({ image, audio, text: p.text });
      return { video, seconds, externalId: null };
    },
  };
}
