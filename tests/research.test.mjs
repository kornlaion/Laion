import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchAdapter, parseIdeas } from '../providers/openai-research.mjs';
import { researchChannel } from '../ops/research.mjs';
import { startScheduler } from '../ops/digest.mjs';
import { createGateway } from '../gateway/gateway.mjs';
import { createMemoryStore } from '../gateway/store-memory.mjs';
import { createHandlers, ideasCarousel } from '../api/app.mjs';
import { parseCommand, parseIdeaPostback } from '../api/line.mjs';

const URLS = ['https://a.example/1', 'https://b.example/2'];
const IDEAS = Array.from({ length: 10 }, (_, i) => ({ title: `หัวข้อที่ ${i + 1}`, hook: `เล่าเรื่องที่ ${i + 1} ให้เข้าใจง่าย`, sources: [{ title: 'A', url: URLS[i % 2] }, { title: 'fake', url: 'https://invented.example/x' }] }));
const respFetch = (seen = {}) => async (url, init) => {
  seen.url = url; seen.init = init; seen.body = JSON.parse(init.body);
  return { ok: true, json: async () => ({ id: 'resp_1', output: [
    { type: 'web_search_call', id: 'ws_1', status: 'completed' },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ideas: IDEAS }), annotations: URLS.map((u) => ({ type: 'url_citation', url: u, title: 't' })) }] },
  ] }) };
};

test('parseIdeas drops source URLs that web search did not cite; too few ideas is an error', () => {
  const ideas = parseIdeas(JSON.stringify({ ideas: IDEAS }), URLS);
  assert.equal(ideas.length, 10);
  assert.deepEqual(ideas[0].sources.map((s) => s.url), ['https://a.example/1']);
  assert.throws(() => parseIdeas(JSON.stringify({ ideas: IDEAS.slice(0, 2) }), URLS), /research_too_few/);
  assert.throws(() => parseIdeas('nope', URLS), /research_parse/);
});

test('adapter: Responses API request shape with web_search tool and Thailand location', async () => {
  const seen = {};
  const ad = createResearchAdapter({ apiKey: 'sk', fetchImpl: respFetch(seen) });
  const out = await ad.call({ channel: 'love', date: '2026-11-13' });
  assert.equal(seen.url, 'https://api.openai.com/v1/responses');
  assert.equal(seen.init.headers.authorization, 'Bearer sk');
  assert.equal(seen.body.tools[0].type, 'web_search');
  assert.equal(seen.body.tools[0].user_location.country, 'TH');
  assert.equal(seen.body.tool_choice, 'required');
  assert.equal(out.ideas.length, 10);
});

function world() {
  const store = createMemoryStore({ rates: [{ provider: 'openai-research', model: 'gpt-4.1', unit: 'call', priceUsd: 0.08 }] });
  const gateway = createGateway({ store, dailyCapThb: 1000, adapters: { 'openai-research': createResearchAdapter({ apiKey: 'k', fetchImpl: respFetch() }) } });
  return { store, gateway };
}

test('researchChannel: billed once through the gateway, ideas stored; same day replays without cost; force re-runs', async () => {
  const { store, gateway } = world();
  const r1 = await researchChannel({ store, gateway, channelId: 'love', date: '2026-11-13' });
  assert.deepEqual([r1.ok, r1.count], [true, 10]);
  assert.equal(store.state.ledger.length, 1);
  assert.equal((await store.listIdeas('love')).length, 10);
  const r2 = await researchChannel({ store, gateway, channelId: 'love', date: '2026-11-13' });
  assert.equal(r2.replay, true);
  assert.equal(store.state.ledger.length, 1);
  assert.equal((await researchChannel({ store, gateway, channelId: 'love', date: '2026-11-13', force: true })).count, 10);
  assert.equal(store.state.ledger.length, 2);
  assert.equal((await store.stuckJobs(0)).length, 0);              // research jobs never show as stuck
});

test('scheduler: research for every channel at 07:30 Bangkok, one summary push, once per day', async () => {
  const { store, gateway } = world();
  const sent = [];
  let t = new Date('2026-11-13T00:20:00Z');                          // 07:20 Bangkok
  const s = startScheduler({ store, push: async (id, m) => sent.push(m[0].text), owners: ['U1'], dailyCapThb: 1000, now: () => t, tickMs: 3600_000,
    research: (ch, date) => researchChannel({ store, gateway, channelId: ch, date }) });
  await s.tick();
  assert.equal(sent.length, 0);
  t = new Date('2026-11-13T00:31:00Z');                              // 07:31
  await s.tick(); await s.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /love 10/);
  assert.match(sent[0], /ไอเดีย <ช่อง>/);
  assert.equal(store.state.ledger.length, 5);
  s.stop();
});

test('ideas command shows a 10-column carousel; buttons: source list, skip, produce starts the normal flow', async () => {
  const { store, gateway } = world();
  await researchChannel({ store, gateway, channelId: 'pet', date: '2026-11-13' });
  const replies = [], pushes = [];
  const h = createHandlers({ store, reply: async (t, m) => replies.push(m), push: async (u, m) => pushes.push(m), gateway, images: {}, baseUrl: 'x' });
  assert.deepEqual(parseCommand('ไอเดีย pet'), { cmd: 'ideas', channel: 'pet' });
  assert.deepEqual(parseCommand('ไอเดียใหม่ pet'), { cmd: 'ideasnew', channel: 'pet' });
  await h.command('U1', { cmd: 'ideas', channel: 'pet' }, 'r1');
  const car = replies.at(-1)[1];
  assert.equal(car.template.columns.length, 10);
  assert.ok(car.template.columns.every((c) => c.title.length <= 40 && c.text.length <= 120 && c.actions.length === 3));
  const mk = parseIdeaPostback(car.template.columns[0].actions[0].data);
  const src = parseIdeaPostback(car.template.columns[0].actions[1].data);
  const skip = parseIdeaPostback(car.template.columns[1].actions[2].data);
  assert.equal(mk.action, 'make');
  await h.idea('U1', src, 'r2');
  assert.match(replies.at(-1)[0].text, /https:\/\/a\.example\/1/);
  await h.idea('U1', skip, 'r3');
  await h.command('U1', { cmd: 'ideas', channel: 'pet' }, 'r4');
  assert.equal(replies.at(-1)[1].template.columns.length, 9);        // skipped one is gone
  await h.idea('U1', mk, 'r5');                                      // produce -> script step (no script adapter here, so it reports a failure, but the idea is marked picked)
  assert.equal((await store.getIdea(mk.ideaId)).status, 'picked');
  await h.idea('U1', mk, 'r6');
  assert.match(replies.at(-1)[0].text, /เลือกไอเดียนี้ไปแล้ว/);
  assert.ok(ideasCarousel([]).template.columns.length === 0);
});
