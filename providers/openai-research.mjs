// Daily topic research with OpenAI's built-in web search (Responses API). Request/response shapes follow the public docs
// (tools: [{type:'web_search'}]; answer in output[type=message].content[].text with url_citation annotations); UNVERIFIED live until the first real call.
import { CHANNEL_GUIDE } from './anthropic-script.mjs';

const SYSTEM = `You are the research editor of a Thai short-video media channel. Use web search to find what is genuinely trending, newsworthy or evergreen-and-useful for a Thai audience, then propose short-video topics.
Rules: never invent facts, numbers, studies or quotes; every idea must rest on at least one real web page you found; no medical advice, diagnoses or treatment claims; no defamation of real people; family friendly.
Reply with ONLY a JSON object: {"ideas":[{"title":"Thai title, at most 40 characters","hook":"one Thai sentence, at most 100 characters, saying what the video says and why viewers care","sources":[{"title":"page title","url":"https://..."}]}]} with exactly 10 ideas.`;

const jsonOf = (raw) => {
  const s = String(raw ?? ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('research_parse');
  try { return JSON.parse(s.slice(a, b + 1)); } catch { throw new Error('research_parse'); }
};

/** Keeps only source URLs that web search actually returned as citations, so the list can never contain invented links. */
export function parseIdeas(raw, citedUrls) {
  const arr = jsonOf(raw).ideas;
  if (!Array.isArray(arr)) throw new Error('research_parse');
  const cited = new Set(citedUrls);
  const ideas = arr.map((x) => ({
    title: String(x?.title ?? '').trim().slice(0, 40),
    hook: String(x?.hook ?? '').trim().slice(0, 100),
    sources: (Array.isArray(x?.sources) ? x.sources : [])
      .filter((s) => typeof s?.url === 'string' && cited.has(s.url))
      .slice(0, 3).map((s) => ({ title: String(s.title ?? '').slice(0, 80), url: s.url })),
  })).filter((x) => x.title && x.hook).slice(0, 10);
  if (ideas.length < 3) throw new Error('research_too_few');
  return ideas;
}

export function createResearchAdapter({ apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_RESEARCH_MODEL ?? 'gpt-4.1', fetchImpl = fetch } = {}) {
  return {
    unit: 'call',
    model: () => model,
    units: () => 1,
    async call(p) {
      if (!apiKey) throw new Error('OPENAI_API_KEY missing');
      const res = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, instructions: SYSTEM, tool_choice: 'required',
          tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'TH', timezone: 'Asia/Bangkok' } }],
          input: `Today is ${p.date}.\nChannel: ${p.channel}\nStyle: ${CHANNEL_GUIDE[p.channel] ?? 'Friendly and clear.'}\nFind 10 fresh video topic ideas for this channel.`,
        }),
      });
      if (!res.ok) {
        let detail = '';
        try { detail = String((await res.json())?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 140); } catch { /* no body */ }
        throw new Error(`openai_research_${res.status}${detail ? `: ${detail}` : ''}`);
      }
      const json = await res.json();
      const msgs = (json.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
      const text = msgs.map((c) => c.text ?? '').join('');
      const cited = msgs.flatMap((c) => c.annotations ?? []).filter((a) => a.type === 'url_citation').map((a) => a.url);
      return { ideas: parseIdeas(text, cited), externalId: json.id ?? null };
    },
  };
}
