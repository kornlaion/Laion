// Script + visual planner. Two Claude calls inside ONE Gateway action ('script'):
//   1) (only when the owner has not supplied a script) write the Thai voice-over;
//   2) design one image prompt per scene. Scene splitting itself is code (render/scenes.mjs), so words never change.
// Request shape follows the public Messages API; UNVERIFIED live until the first real call.
import { sceneCount, splitScenes } from '../render/scenes.mjs';
import { MODES, DEFAULT_MODE, lengthFor } from '../render/formats.mjs';

export const CHANNEL_GUIDE = {
  love: 'Channel KORN AVA (Love & Happiness). Music-led: write short, lyrical, heartfelt lines with room to breathe so music carries the mood. Warm, romantic, hopeful; small happy moments.',
  mindbody: 'Channel Melody Svaha. Calm, gentle, grounding. General wellbeing habits only. NEVER give medical advice, diagnoses, treatments or health claims.',
  'energy-ai': 'Channel LAION BEYOND. Clear, curious, factual tone about EVs, energy and AI tools. Keep claims general; do not invent numbers, prices or specs.',
  healthtech: 'Channel LAION EVER. Plain-language explainers about health technology. NEVER give medical advice, diagnoses, treatment or efficacy claims; say it is general information.',
  pet: 'Channel LAION UNIVERSE: an original IP character plus weekly horoscope. Playful, warm, family friendly. Horoscope is entertainment only: general, positive, never predict illness, money, death or make guarantees; say it is for fun.',
};

// Shared look so every scene feels like one film. Appended to every scene prompt in code.
export const STYLE_ZEN = 'Japanese zen minimalism, serene and elegant, soft diffused natural light, muted warm earth tones with a touch of sage green, generous negative space, shallow depth of field, fine film grain, vertical 2:3 composition with the subject in the upper two thirds and a calm quiet area in the lower third, no text, no letters, no logos, no watermark, no people facing the camera';

// Per-channel picture style. 'love' is a PLACEHOLDER until the owner's earlier KORN AVA clips are analysed; other channels fall back to STYLE_ZEN.
export const STYLE_BY_CHANNEL = {
  love: 'cinematic romantic mood, warm dusk and night light, soft bokeh, gentle film grain, dreamy and tender, vertical 2:3 composition with the subject in the upper two thirds and a calm darker area in the lower third for lyrics, no text, no letters, no logos, no watermark, no faces looking at the camera',
};

const SYSTEM_MUSIC_VISUAL = `You are the art director of a music-led vertical video for an original Thai love song. You receive numbered scenes; each has the sung lyrics for that moment (a scene marked "(instrumental)" has no lyrics). For each scene write ONE image prompt in English: a concrete, beautiful still that carries the feeling of those lyrics (night sky and stars, city lights, rain on glass, hands, silhouettes from behind, flowers, a quiet room, letters, moonlight on water...). Keep one consistent visual language across all scenes and let the story progress from scene to scene. Never show readable text, real people's faces or brands. Do not describe the overall style (it is added automatically), only the subject and setting.
Reply with ONLY a JSON object (no markdown) with exactly one key: "image_prompts": an array with exactly one English prompt per scene, in order.`;

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

const SYSTEM_CAPTION = `You write posting copy for one finished Thai short video, for four platforms. Reply with ONLY a JSON object (no markdown):
{"tiktok":{"caption":"...","hashtags":["..."]},"instagram":{"caption":"...","hashtags":["..."]},"youtube":{"title":"...","description":"...","hashtags":["..."]},"facebook":{"caption":"...","hashtags":["..."]}}
Rules: Thai; start with a hook line that makes people stop; captions short (1-3 lines), warm and natural, one gentle call to action at most; 3-5 relevant hashtags without the # sign (youtube must include "Shorts"); YouTube title at most 90 characters; never invent facts, numbers or claims; no medical advice, no cure or efficacy claims; no real brand or person names; family friendly.`;

export function parseCaptions(raw) {
  const o = jsonOf(raw);
  const tags = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean).slice(0, 8);
  const str = (x, n) => String(x ?? '').trim().slice(0, n);
  const out = {
    tiktok: { caption: str(o.tiktok?.caption, 300), hashtags: tags(o.tiktok?.hashtags) },
    instagram: { caption: str(o.instagram?.caption, 600), hashtags: tags(o.instagram?.hashtags) },
    youtube: { title: str(o.youtube?.title, 100), description: str(o.youtube?.description, 500), hashtags: tags(o.youtube?.hashtags) },
    facebook: { caption: str(o.facebook?.caption, 600), hashtags: tags(o.facebook?.hashtags) },
  };
  if (!out.tiktok.caption || !out.instagram.caption || !out.youtube.title || !out.facebook.caption) throw new Error('caption_incomplete');
  if (!out.youtube.hashtags.some((h) => h.toLowerCase() === 'shorts')) out.youtube.hashtags.push('Shorts');
  return out;
}

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
    units: (p) => (p.task === 'caption' || p.task === 'music' ? 1 : p.script ? 1 : 2),
    async call(p) {
      if (p.task === 'caption') {
        const c = await ask(SYSTEM_CAPTION, `Channel: ${p.channel}\nStyle: ${CHANNEL_GUIDE[p.channel] ?? 'Friendly and clear.'}\nTitle: ${p.title}\nVoice-over (Thai):\n${p.script}`, 1200);
        return { captions: parseCaptions(c.text), externalId: c.id };
      }
      const guide = `Channel: ${p.channel}\nStyle: ${CHANNEL_GUIDE[p.channel] ?? 'Friendly and clear.'}\nGrade: ${p.grade}`;
      if (p.task === 'music') {
        const texts = (p.scenes ?? []).map((t) => String(t ?? '').trim());
        if (texts.length < 2 || texts.length > 24) throw new Error('music_scene_count');
        const v = await ask(SYSTEM_MUSIC_VISUAL, `${guide}\nSong (Thai title): ${p.title}\nNumber of scenes: ${texts.length}\n\n${texts.map((t, i) => `Scene ${i + 1}${t ? '' : ' (instrumental)'}:\n${t}`).join('\n\n')}`);
        const vis = parseVisual(JSON.stringify({ image_prompts: JSON.parse(v.text.slice(v.text.indexOf('{'), v.text.lastIndexOf('}') + 1)).image_prompts }), texts.length);
        const style = STYLE_BY_CHANNEL[p.channel] ?? STYLE_ZEN;
        return { plan: { title: p.title, style, scenes: texts.map((text, i) => ({ text: text || '♪', visual: vis.prompts[i], image_prompt: `${vis.prompts[i]}. ${style}` })) }, externalId: v.id };
      }
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
