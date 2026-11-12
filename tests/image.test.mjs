import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../api/app.mjs';
import { createImageCache } from '../api/images.mjs';
import { createGateway } from '../gateway/gateway.mjs';
import { createMemoryStore } from '../gateway/store-memory.mjs';
import { createOpenAIImageAdapter } from '../providers/openai-image.mjs';
import { parseCommand, parsePostback } from '../api/line.mjs';

const rates = [{ provider: 'openai', model: 'gpt-image-2:low', unit: 'image', priceUsd: 0.009 }];

function setup({ fetchImpl } = {}) {
  const store = createMemoryStore({ rates });
  const replies = []; const pushes = [];
  const adapter = createOpenAIImageAdapter({ apiKey: 'k', fetchImpl });
  const gateway = createGateway({ store, adapters: { openai: adapter }, dailyCapThb: 1000 });
  const images = createImageCache();
  const h = createHandlers({ store, reply: async (t, m) => replies.push(m[0]), push: async (u, m) => pushes.push(m), gateway, images, baseUrl: 'https://x.test' });
  return { store, h, replies, pushes, images };
}
const okFetch = async (url, init) => {
  okFetch.last = JSON.parse(init.body);
  return { ok: true, json: async () => ({ created: 1, data: [{ b64_json: Buffer.from('jpegdata').toString('base64') }] }) };
};

test('parseCommand reads image quality and prompt', () => {
  assert.deepEqual(parseCommand('ภาพ แมวนั่งใต้ฝน'), { cmd: 'image', quality: 'low', prompt: 'แมวนั่งใต้ฝน' });
  assert.equal(parseCommand('ภาพ high หัวใจสีทอง').quality, 'high');
});

test('image without approved Gate A is refused and nothing is called', async () => {
  const { h, replies, store } = setup({ fetchImpl: okFetch });
  await h.command('U1', parseCommand('ภาพ แมว'), 'rt');
  assert.match(replies.at(-1).text, /Gate A/);
  assert.equal(store.state.ledger.length, 0);
});

test('approved job: image generated, billed once, URL pushed; replayed token is not billed twice', async () => {
  const { h, replies, pushes, store, images } = setup({ fetchImpl: okFetch });
  await h.command('U1', parseCommand('สร้าง love G1 เพลงทดสอบ'), 'r0');
  const pb = parsePostback(replies.at(-1).template.actions[0].data);
  await h.postback('U1', pb, 'r1');
  await h.command('U1', parseCommand('ภาพ แมวนั่งใต้ฝน'), 'r2');
  assert.equal(okFetch.last.model, 'gpt-image-2');
  assert.equal(okFetch.last.quality, 'low');
  assert.equal(store.state.ledger.length, 1);
  const img = pushes.at(-1)[0];
  assert.equal(img.type, 'image');
  assert.match(img.originalContentUrl, /^https:\/\/x\.test\/img\/[0-9a-f]{48}\.jpg$/);
  assert.equal(images.get(img.originalContentUrl.match(/img\/(.+)\.jpg/)[1]).toString(), 'jpegdata');
  await h.command('U1', parseCommand('ภาพ แมวนั่งใต้ฝน'), 'r2');   // LINE redelivery, same token
  assert.equal(store.state.ledger.length, 1);
  assert.match(pushes.at(-1)[0].text, /ทำไปแล้ว/);
});

test('provider failure is reported and not billed', async () => {
  const { h, replies, pushes, store } = setup({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  await h.command('U1', parseCommand('สร้าง love G1 x'), 'r0');
  await h.postback('U1', parsePostback(replies.at(-1).template.actions[0].data), 'r1');
  await h.command('U1', parseCommand('ภาพ แมว'), 'r2');
  assert.match(pushes.at(-1)[0].text, /ไม่สำเร็จ/);
  assert.equal(store.state.ledger.length, 0);
});

import { signRequest, createR2 } from '../storage/r2.mjs';
import { makeServer } from '../api/server.mjs';

test('R2 signer is deterministic and signs the headers it sends', () => {
  const a = { method: 'PUT', host: 'acc.r2.cloudflarestorage.com', path: '/b/jobs/x.jpg', body: Buffer.from('d'), accessKeyId: 'AK', secretAccessKey: 'SK', now: new Date('2026-11-12T12:00:00Z') };
  const s1 = signRequest(a), s2 = signRequest(a);
  assert.equal(s1.authorization, s2.authorization);
  assert.match(s1.authorization, /Credential=AK\/20261112\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}/);
  assert.notEqual(signRequest({ ...a, body: Buffer.from('e') }).authorization, s1.authorization);
});

test('with storage: image saved to R2, asset row written, served by asset id', async () => {
  const puts = [];
  const storage = { put: async (k, b, t) => puts.push([k, b.toString(), t]), get: async () => Buffer.from('jpegdata') };
  const store = createMemoryStore({ rates });
  const pushes = []; const replies = [];
  const gateway = createGateway({ store, adapters: { openai: createOpenAIImageAdapter({ apiKey: 'k', fetchImpl: okFetch }) }, dailyCapThb: 1000 });
  const images = createImageCache();
  const h = createHandlers({ store, reply: async (t, m) => replies.push(m[0]), push: async (u, m) => pushes.push(m), gateway, images, storage, baseUrl: 'https://x.test' });
  await h.command('U1', parseCommand('สร้าง love G1 x'), 'r0');
  await h.postback('U1', parsePostback(replies.at(-1).template.actions[0].data), 'r1');
  await h.command('U1', parseCommand('ภาพ แมว'), 'r2');
  assert.equal(puts.length, 1);
  assert.match(puts[0][0], /^jobs\/.+\.jpg$/);
  const id = pushes.at(-1)[0].originalContentUrl.match(/img\/(.+)\.jpg/)[1];
  assert.equal(id.length, 36);
  const server = makeServer({ secret: 's', allow: new Set(), handlers: {}, images, assets: async (i) => (await store.getAsset(i)) && storage.get() });
  await new Promise((r) => server.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/img/${id}.jpg`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'jpegdata');
  server.close();
});

test('Gate B: card follows the image; revise does not lock; approve is final; B needs A', async () => {
  const { h, replies, pushes, store } = setup({ fetchImpl: okFetch });
  await h.command('U1', parseCommand('สร้าง love G2 x'), 'r0');
  const a = parsePostback(replies.at(-1).template.actions[0].data);
  await h.postback('U1', { jobId: a.jobId, gate: 'B', decision: 'approve', nonce: 'abcd1234' }, 'r1b');  // B before A
  assert.match(replies.at(-1).text, /ต้องผ่าน Gate A/);
  await h.postback('U1', a, 'r2');
  await h.command('U1', parseCommand('ภาพ แมว'), 'r3');
  const card = pushes.at(-1)[2];
  assert.equal(parsePostback(card.template.actions[0].data).gate, 'B');
  await h.postback('U1', parsePostback(card.template.actions[1].data), 'r4');                // revise
  assert.match(replies.at(-1).text, /สร้างใหม่/);
  await h.command('U1', parseCommand('ภาพ แมวใหม่'), 'r5');
  const card2 = pushes.at(-1)[2];
  await h.postback('U1', parsePostback(card2.template.actions[0].data), 'r6');               // approve
  assert.match(replies.at(-1).text, /ผ่าน Gate B/);
  assert.deepEqual((await store.approvedGates(a.jobId)).sort(), ['A', 'B']);
  await h.command('U1', parseCommand('ภาพ แมวอีก'), 'r7');
  assert.equal(pushes.at(-1).length, 2);                                                     // no new B card once decided
});

import { createElevenLabsAdapter } from '../providers/elevenlabs.mjs';

test('voice: billed per 1k chars at list price, mp3 saved and served, replay not billed, failure not billed', async () => {
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen.url = url; seen.body = JSON.parse(init.body); seen.key = init.headers['xi-api-key'];
    return { ok: true, headers: { get: () => 'req1' }, arrayBuffer: async () => Buffer.from('mp3bytes') };
  };
  const vrates = [{ provider: 'elevenlabs', model: 'eleven_v4', unit: '1k_chars', priceUsd: 0.08 }];
  const store = createMemoryStore({ rates: vrates });
  const replies = []; const pushes = []; const puts = [];
  const gateway = createGateway({ store, adapters: { elevenlabs: createElevenLabsAdapter({ apiKey: 'k', voiceId: 'VID', model: 'eleven_v4', fetchImpl }) }, dailyCapThb: 1000 });
  const h = createHandlers({ store, reply: async (t, m) => replies.push(m[0]), push: async (u, m) => pushes.push(m), gateway, images: createImageCache(),
    storage: { put: async (k, b, t) => puts.push([k, t]) }, baseUrl: 'https://x.test' });
  await h.command('U1', parseCommand('สร้าง love G1 x'), 'r0');
  await h.postback('U1', parsePostback(replies.at(-1).template.actions[0].data), 'r1');
  const text = 'สวัสดีครับ'.repeat(20);                              // 200 chars
  await h.command('U1', parseCommand(`เสียง ${text}`), 'r2');
  assert.match(seen.url, /text-to-speech\/VID\?output_format=mp3_44100_128/);
  assert.equal(seen.body.model_id, 'eleven_v4');
  assert.equal(seen.key, 'k');
  assert.equal(store.state.ledger.length, 1);
  assert.ok(Math.abs(store.state.ledger[0].costUsd - 0.016) < 1e-9);          // 0.2k chars x $0.08
  assert.match(pushes.at(-1)[0].text, /https:\/\/x\.test\/aud\/[0-9a-f-]{36}\.mp3/);
  assert.match(puts[0][0], /\.mp3$/); assert.equal(puts[0][1], 'audio/mpeg');
  await h.command('U1', parseCommand(`เสียง ${text}`), 'r2');                 // redelivery
  assert.equal(store.state.ledger.length, 1);

  const bad = createGateway({ store, adapters: { elevenlabs: createElevenLabsAdapter({ apiKey: 'k', voiceId: 'V', fetchImpl: async () => ({ ok: false, status: 422 }) }) }, dailyCapThb: 1000 });
  const h2 = createHandlers({ store, reply: async () => {}, push: async (u, m) => pushes.push(m), gateway: bad, images: createImageCache(), baseUrl: 'https://x.test' });
  await h2.command('U1', parseCommand('เสียง ทดสอบ'), 'r9');
  assert.match(pushes.at(-1)[0].text, /ไม่สำเร็จ.*elevenlabs_422/);
  assert.equal(store.state.ledger.length, 1);
});
