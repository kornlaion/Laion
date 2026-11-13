// Script + visual planner. Two Claude calls inside ONE Gateway action ('script'):
//   1) (only when the owner has not supplied a script) write the Thai voice-over;
//   2) design one image prompt per scene. Scene splitting itself is code (render/scenes.mjs), so words never change.
// Request shape follows the public Messages API; UNVERIFIED live until the first real call.
import { sceneCount, splitScenes } from '../render/scenes.mjs';
import { MODES, DEFAULT_MODE, lengthFor } from '../render/formats.mjs';

export const CHANNEL_GUIDE = {
  love: 'Warm, romantic, hopeful. Short heartfelt lines about love and small happy moments.',
  mindbody: 'Calm, gentle, grounding. General wellbeing habits only. NEVER give medical advice, diagnoses, treatments or health claims.',
  'energy-ai': 'Clear, curious, factual tone about EVs, energy and AI tools. Keep claims general; do not invent numbers, prices or specs.',
  healthtech: 'Plain-language explainers about health technology. NEVER give medical advice, diagnoses, treatment or efficacy claims; say it is general information.',
  pet: 'Playful, cute, funny story about a pet character. Light, family friendly.',
};

// Shared look so every scene feels like one film. Appended to every scene prompt in code.
export const STYLE_ZEN = 'Japanese zen minimalism, serene and elegant, soft diffused natural light, muted warm earth tones with a touch of sage green, generous negative space, shallow depth of field, fine film grain, vertical 2:3 composition with the subject in the upper two thirds and a calm quiet area in the lower third, no text, no letters, no logos, no watermark, no people facing the camera';

function writeSystem(modeKey) {
  const m = MODES[modeKey] ?? MODES[DEFAULT_MODE];
  const L = lengthFor(MODES[modeKey] ? modeKey : DEFAULT_MODE);
  return `You write short vertical-video scripts for an automated media channel. Reply with ONLY a JSON object (no markdown, no commentary) with exactly these keys:
- "title": Thai title, at most 40 characters.
- "script": the Thai voice-over, natural spoken Thai, no emoji, no stage directions, no hashtags. Put each thought on its own line (separate lines with a newline), each line at most about 40 characters. Length: about ${L.target} Thai characters (between ${L.min} and ${L.max}), for a clip of ${m.secs[0]}-${m.secs[1]} seconds. Hard maximum 1000 characters.
- "voice": "female" or "male", whichever suits the script.
ALWAYS use this engaging structure:
1. HOOK: the very first line, spoken in about 3 seconds (under 30 Thai characters). A question, a surprising claim or an intriguing promise that makes people stop scrolling. Never a greeting, never the channel name.
2. BODY: clear and concise, one idea per line, no filler, every line must earn its place.
3. PEAK: the key insight, twist or result, placed about 70-90% of the way through.
4. CLOSE: one short closing line (a takeaway, a gentle invitation to follow, save or reflect), spoken in about 2 seconds. End right there.
Rules: never invent statistics, prices, studies, quotes or news; do not name real brands or real people; keep it positive and safe for a general audience.`;
}

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

/** vendor 'anthropic' (Messages API) or 'openai' (Chat Completions). Same planning logic either way. Live shapes UNVERIFIED until the first real call. */
export function createScriptAdapter({
  vendor = 'anthropic', apiKey, model, fetchImpl = fetch,
} = {}) {
  const openai = vendor === 'openai';
  apiKey ??= openai ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  model ??= openai ? (process.env.OPENAI_PLAN_MODEL ?? 'gpt-4.1') : (process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5');

  async function ask(system, user, maxTokens = 1800) {
    if (!apiKey) throw new Error(`${openai ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} missing`);
    const res = openai
      ? await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_completion_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      })
      : await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      });
    const tag = openai ? 'openai_text' : 'anthropic';
    if (!res.ok) {
      let detail = '';
      try { detail = String((await res.json())?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 140); } catch { /* no body */ }   // the API's own reason; never contains the key
      throw new Error(`${tag}_${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const json = await res.json();
    const out = openai
      ? String(json.choices?.[0]?.message?.content ?? '')
      : (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { text: out, id: json.id ?? null };
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
        const w = await ask(writeSystem(p.mode), `${guide}\nTopic (Thai): ${p.topic}`);
        ({ title, script, voice } = parseWrite(w.text));
        lastId = w.id;
      }
      const texts = splitScenes(script, sceneCount([...script].length));
      const v = await ask(SYSTEM_VISUAL, `${guide}\nTitle (Thai): ${title}\nNumber of scenes: ${texts.length}\n\n${texts.map((t, i) => `Scene ${i + 1}:\n${t}`).join('\n\n')}`);
      const vis = parseVisual(v.text, texts.length);
      lastId = v.id ?? lastId;
      const plan = {
        title: (p.script ? p.topic : title) || vis.title || 'ไม่มีชื่อ',
        ...(p.script ? {} : { mode: p.mode ?? DEFAULT_MODE }),
        script,                                                       // owner's words byte for byte, or Claude's own script
        voice: voice ?? vis.voice,
        scenes: texts.map((text, i) => ({ text, visual: vis.prompts[i], image_prompt: `${vis.prompts[i]}. ${STYLE_ZEN}` })),
      };
      return { plan, externalId: lastId };
    },
  };
}
