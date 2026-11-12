// Script writer: asks Claude for a Thai voice-over script + an English image prompt, as strict JSON.
// Routed through the Gateway (action 'script'), so it has a ledger line and the same kill switch and caps as everything else.
// Request shape follows the public Messages API; UNVERIFIED live until the first real call.
const CHANNEL_GUIDE = {
  love: 'Warm, romantic, hopeful. Short heartfelt lines about love and small happy moments.',
  mindbody: 'Calm, gentle, grounding. General wellbeing habits only. NEVER give medical advice, diagnoses, treatments or health claims.',
  'energy-ai': 'Clear, curious, factual tone about EVs, energy and AI tools. Keep claims general; do not invent numbers, prices or specs.',
  healthtech: 'Plain-language explainers about health technology. NEVER give medical advice, diagnoses, treatment or efficacy claims; say it is general information.',
  pet: 'Playful, cute, funny story about a pet character. Light, family friendly.',
};

const SYSTEM = `You write short vertical-video scripts for an automated media channel. Reply with ONLY a JSON object (no markdown, no commentary) with exactly these keys:
- "title": Thai title, at most 40 characters.
- "script": the Thai voice-over, natural spoken Thai, no emoji, no stage directions, no hashtags. 150-300 characters for grades G0-G1, up to 380 for higher grades. Hard maximum 400 characters.
- "image_prompt": ONE concrete vertical scene in English for an image model (subject, setting, light, mood, style). No text, letters, logos, watermarks or real people in the image.
- "voice": "female" or "male", whichever suits the script.
Rules: never invent statistics, prices, studies, quotes or news; do not name real brands or real people; keep it positive and safe for a general audience.`;

const SYSTEM_CUSTOM = `The channel owner supplies a finished Thai script. Do NOT rewrite, shorten or add to it. Reply with ONLY a JSON object (no markdown) with exactly these keys:
- "title": Thai title, at most 40 characters (use the owner's title if given).
- "image_prompt": ONE concrete vertical scene in English that fits the mood of the script (subject, setting, light, mood, style). No text, letters, logos, watermarks or real people in the image.
- "voice": "female" or "male", whichever suits the script.`;

export function parsePlan(raw, { custom = false } = {}) {
  const s = String(raw ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('script_parse');
  let o;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch { throw new Error('script_parse'); }
  const script = custom ? 'OWNER' : String(o.script ?? '').trim();
  const image_prompt = String(o.image_prompt ?? '').trim();
  if (!script || !image_prompt) throw new Error('script_incomplete');
  if (!custom && [...script].length > 400) throw new Error('script_too_long');
  return { title: String(o.title ?? '').trim().slice(0, 60) || 'ไม่มีชื่อ', script, image_prompt, voice: o.voice === 'male' ? 'male' : 'female' };
}

export function createScriptAdapter({
  apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5', fetchImpl = fetch,
} = {}) {
  return {
    unit: 'call',
    model: () => model,
    units: () => 1,
    async call(p) {
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model, max_tokens: 1500, system: p.script ? SYSTEM_CUSTOM : SYSTEM,
          messages: [{ role: 'user', content: `Channel: ${p.channel}\nStyle: ${CHANNEL_GUIDE[p.channel] ?? 'Friendly and clear.'}\nGrade: ${p.grade}\n${p.script ? `Title (Thai): ${p.topic}\nOwner script (Thai):\n${p.script}` : `Topic (Thai): ${p.topic}`}` }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic_${res.status}`);          // body not logged
      const json = await res.json();
      const plan = parsePlan((json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''), { custom: Boolean(p.script) });
      if (p.script) plan.script = p.script;                          // the owner's words, byte for byte
      return { plan, externalId: json.id ?? null };
    },
  };
}
