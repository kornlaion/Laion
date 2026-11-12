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
