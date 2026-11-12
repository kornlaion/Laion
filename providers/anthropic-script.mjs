// Script + visual planner. Two Claude calls inside ONE Gateway action ('script'):
//   1) (only when the owner has not supplied a script) write the Thai voice-over;
//   2) design one image prompt per scene. Scene splitting itself is code (render/scenes.mjs), so words never change.
// Request shape follows the public Messages API; UNVERIFIED live until the first real call.
import { sceneCount, splitScenes } from '../render/scenes.mjs';

const CHANNEL_GUIDE = {
  love: 'Warm, romantic, hopeful. Short heartfelt lines about love and small happy moments.',
  mindbody: 'Calm, gentle, grounding. General wellbeing habits only. NEVER give medical advice, diagnoses, treatments or health claims.',
  'energy-ai': 'Clear, curious, factual tone about EVs, energy and AI tools. Keep claims general; do not invent numbers, prices or specs.',
  healthtech: 'Plain-language explainers about health technology. NEVER give medical advice, diagnoses, treatment or efficacy claims; say it is general information.',
  pet: 'Playful, cute, funny story about a pet character. Light, family friendly.',
};

// Shared look so every scene feels like one film. Appended to every scene prompt in code.
export const STYLE_ZEN = 'Japanese zen minimalism, serene and elegant, soft diffused natural light, muted warm earth tones with a touch of sage green, generous negative space, shallow depth of field, fine film grain, vertical 2:3 composition with the subject in the upper two thirds and a calm quiet area in the lower third, no text, no letters, no logos, no watermark, no people facing the camera';

const SYSTEM_WRITE = `You write short vertical-video scripts for an automated media channel. Reply with ONLY a JSON object (no markdown, no commentary) with exactly these keys:
- "title": Thai title, at most 40 characters.
- "script": the Thai voice-over, natural spoken Thai, no emoji, no stage directions, no hashtags. Put each thought on its own line (separate lines with a newline). 300-600 characters for grades G0-G1, up to 900 for higher grades. Hard maximum 1000 characters.
- "voice": "female" or "male", whichever suits the script.
Rules: never invent statistics, prices, studies, quotes or news; do not name real brands or real people; keep it positive and safe for a general audience.`;

const SYSTEM_VISUAL = `You are the art director of a calm, elegant ZEN-style vertical video. You receive numbered scenes of a Thai voice-over. For each scene write ONE image prompt in English: a concrete, beautiful, minimal still that matches the feeling of that scene's words (nature, objects, hands, silhouettes, light, water, tea, stone, paper, fabric, mist...). Keep a consistent visual language across scenes. Never show readable text, real people's faces or brands. Do not describe the overall style (it is added automatically), only the subject and setting.
Reply with ONLY a JSON object (no markdown) with exactly these keys:
- "title": Thai title, at most 40 characters (use the given title if one is provided).
- "voice": "female" or "male", whichever suits the script.
- "image_prompts": an array with exactly one English prompt per scene, in order.`;

const jsonOf = (raw) => {
  const s = String(raw ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('script_parse');
  try { return JSON.parse(s.slice(a, b + 1)); } catch { throw new Error('script_parse'); }
};

export function parseWrite(raw) {
  const o = jsonOf(raw);
  const script = String(o.script ?? '').trim();
  if (!script) throw new Error('script_incomplete');
  if ([...script].length > 1000) throw new Error('script_too_long');
  return { title: String(o.title ?? '').trim().slice(0, 60) || 'ไม่มีชื่อ', script, voice: o.voice === 'male' ? 'male' : 'female' };
}

export function parseVisual(raw, n) {
  const o = jsonOf(raw);
  const prompts = Array.isArray(o.image_prompts) ? o.image_prompts.map((x) => String(x ?? '').trim()) : [];
  if (prompts.length !== n || prompts.some((x) => !x)) throw new Error('visual_count_mismatch');
  return { title: String(o.title ?? '').trim().slice(0, 60), voice: o.voice === 'male' ? 'male' : 'female', prompts };
}

export function createScriptAdapter({
  apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5', fetchImpl = fetch,
} = {}) {
  async function ask(system, user, maxTokens = 1800) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`anthropic_${res.status}`);          // body not logged
    const json = await res.json();
    return { text: (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''), id: json.id ?? null };
  }

  return {
    unit: 'call',
    model: () => model,
    units: (p) => (p.script ? 1 : 2),
    async call(p) {
      const guide = `Channel: ${p.channel}\nStyle: ${CHANNEL_GUIDE[p.channel] ?? 'Friendly and clear.'}\nGrade: ${p.grade}`;
      let title = p.topic, script = p.script, voice;
      let lastId = null;
      if (!script) {
        const w = await ask(SYSTEM_WRITE, `${guide}\nTopic (Thai): ${p.topic}`);
        ({ title, script, voice } = parseWrite(w.text));
        lastId = w.id;
      }
      const texts = splitScenes(script, sceneCount([...script].length));
      const v = await ask(SYSTEM_VISUAL, `${guide}\nTitle (Thai): ${title}\nNumber of scenes: ${texts.length}\n\n${texts.map((t, i) => `Scene ${i + 1}:\n${t}`).join('\n\n')}`);
      const vis = parseVisual(v.text, texts.length);
      lastId = v.id ?? lastId;
      const plan = {
        title: (p.script ? p.topic : title) || vis.title || 'ไม่มีชื่อ',
        script,                                                       // owner's words byte for byte, or Claude's own script
        voice: voice ?? vis.voice,
        scenes: texts.map((text, i) => ({ text, visual: vis.prompts[i], image_prompt: `${vis.prompts[i]}. ${STYLE_ZEN}` })),
      };
      return { plan, externalId: lastId };
    },
  };
}
