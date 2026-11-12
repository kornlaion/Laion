import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../gateway/gateway.mjs';
import { createMemoryStore } from '../gateway/store-memory.mjs';
import { createOpenAIImageAdapter } from '../providers/openai-image.mjs';

const job = { id: 'j1', channelId: 'love', grade: 'G1', requiresExpert: false, capThb: 35 };
const rates = [{ provider: 'fake', model: 'm', unit: 'image', priceUsd: 0.1 }]; // 0.1 usd = 3.3 THB

const fakeAdapter = (impl) => ({
  unit: 'image', model: () => 'm', units: (p) => p.n ?? 1,
  call: impl ?? (async () => ({ images: [Buffer.from('x')], externalId: 'e1' })),
});

function setup({ approvals = [{ jobId: 'j1', gate: 'A', decision: 'approve' }], adapter = fakeAdapter(), killed = {} } = {}) {
  const store = createMemoryStore({ jobs: [job], rates, approvals, killed });
  const gw = createGateway({ store, adapters: { fake: adapter }, dailyCapThb: 1000 });
  const req = (over = {}) => ({ jobId: 'j1', action: 'image', provider: 'fake', params: { n: 1 }, idempotencyKey: 'k1', actor: 'worker', ...over });
  return { store, gw, req };
}

test('allowed call records task, ledger and audit', async () => {
  const { store, gw, req } = setup();
  const r = await gw.run(req());
  assert.equal(r.ok, true);
  assert.equal(r.costThb, 3.3);
  assert.equal(store.state.ledger.length, 1);
  assert.equal(store.state.tasks[0].status, 'done');
  assert.ok(store.state.auditLog.some((a) => a.action.startsWith('ok:')));
});

test('blocked without gate A, nothing charged', async () => {
  const { store, gw, req } = setup({ approvals: [] });
  const r = await gw.run(req());
  assert.deepEqual([r.ok, r.reason], [false, 'gate_missing_A']);
  assert.equal(store.state.ledger.length, 0);
  assert.equal(store.state.tasks.length, 0);
});

test('video needs gate B even with A', async () => {
  const { gw, req } = setup();
  const r = await gw.run(req({ action: 'video' }));
  assert.equal(r.reason, 'gate_missing_B');
});

test('same idempotency key is replayed, charged once', async () => {
  const { store, gw, req } = setup();
  await gw.run(req());
  const again = await gw.run(req());
  assert.equal(again.replay, true);
  assert.equal(store.state.ledger.length, 1);
});

test('provider error marks task failed and does not bill', async () => {
  const { store, gw, req } = setup({ adapter: fakeAdapter(async () => { throw new Error('boom'); }) });
  const r = await gw.run(req());
  assert.deepEqual([r.ok, r.reason], [false, 'provider_error']);
  assert.equal(store.state.tasks[0].status, 'failed');
  assert.equal(store.state.ledger.length, 0);
});

test('job cap stops the next call', async () => {
  const { gw, req } = setup();
  const r = await gw.run(req({ params: { n: 12 } })); // 12 x 3.3 = 39.6 > 35
  assert.equal(r.reason, 'job_cap_exceeded');
});

test('kill switch and missing rate are refused', async () => {
  const a = setup({ killed: { providers: ['fake'] } });
  assert.equal((await a.gw.run(a.req())).reason, 'kill_switch_provider');
  const store = createMemoryStore({ jobs: [job], rates: [], approvals: [{ jobId: 'j1', gate: 'A', decision: 'approve' }] });
  const gw = createGateway({ store, adapters: { fake: fakeAdapter() } });
  assert.equal((await gw.run({ jobId: 'j1', action: 'image', provider: 'fake', idempotencyKey: 'k', actor: 'worker' })).reason, 'no_rate');
});

test('agents cannot trigger a paid call', async () => {
  const { gw, req } = setup();
  assert.equal((await gw.run(req({ actor: 'agent:writer' }))).reason, 'actor_not_allowed');
});

test('openai image adapter builds the request and decodes base64', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ created: 1, data: [{ b64_json: Buffer.from('png').toString('base64') }] }) };
  };
  const ad = createOpenAIImageAdapter({ apiKey: 'sk-test', model: 'gpt-image-2', fetchImpl });
  assert.equal(ad.model({ quality: 'low' }), 'gpt-image-2:low');
  const out = await ad.call({ prompt: 'a cat', quality: 'low' });
  assert.equal(seen.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(seen.init.headers.authorization, 'Bearer sk-test');
  assert.equal(JSON.parse(seen.init.body).quality, 'low');
  assert.equal(out.images[0].toString(), 'png');
});

test('openai image adapter surfaces HTTP errors', async () => {
  const ad = createOpenAIImageAdapter({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(() => ad.call({ prompt: 'x' }), /openai_image_429/);
});
