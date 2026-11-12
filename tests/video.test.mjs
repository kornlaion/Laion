import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createHandlers } from '../api/app.mjs';
import { makeServer } from '../api/server.mjs';
import { createImageCache } from '../api/images.mjs';
import { createGateway } from '../gateway/gateway.mjs';
import { createMemoryStore } from '../gateway/store-memory.mjs';
import { createOpenAIImageAdapter } from '../providers/openai-image.mjs';
import { createElevenLabsAdapter } from '../providers/elevenlabs.mjs';
import { createRenderAdapter } from '../providers/render.mjs';
import { parseCommand, parsePostback } from '../api/line.mjs';

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

test('parseCommand: video with optional gender', () => {
  assert.deepEqual(parseCommand('วิดีโอ หญิง สวัสดีค่ะ'), { cmd: 'video', voice: 'female', text: 'สวัสดีค่ะ' });
  assert.equal(parseCommand('วิดีโอ สวัสดีครับ').voice, undefined);
});

test('video end to end: needs B, bills voice+render once, stores mp4, Gate D, Range serving', { skip: !hasFfmpeg }, async () => {
  const tmp = fs.mkdtempSync('/tmp/vt-');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'gradients=s=1024x1536:d=1', '-frames:v', '1', `${tmp}/i.jpg`]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libmp3lame', `${tmp}/a.mp3`]);
  const jpg = fs.readFileSync(`${tmp}/i.jpg`), mp3 = fs.readFileSync(`${tmp}/a.mp3`);

  const files = new Map();
  const storage = { put: async (k, b) => files.set(k, b), get: async (k) => files.get(k) ?? null };
  const rates = [
    { provider: 'openai', model: 'gpt-image-2:low', unit: 'image', priceUsd: 0.009 },
    { provider: 'elevenlabs', model: 'eleven_v4', unit: '1k_chars', priceUsd: 0.08 },
    { provider: 'render', model: 'ffmpeg', unit: 'second', priceUsd: 0.0005 },
  ];
  const store = createMemoryStore({ rates });
  const imgFetch = async () => ({ ok: true, json: async () => ({ data: [{ b64_json: jpg.toString('base64') }] }) });
  const ttsFetch = async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => mp3 });
  const gateway = createGateway({ store, dailyCapThb: 1000, adapters: {
    openai: createOpenAIImageAdapter({ apiKey: 'k', fetchImpl: imgFetch }),
    elevenlabs: createElevenLabsAdapter({ apiKey: 'k', voiceId: 'V', model: 'eleven_v4', fetchImpl: ttsFetch }),
    render: createRenderAdapter({ storage }),
  } });
  const replies = [], pushes = [];
  const images = createImageCache();
  const h = createHandlers({ store, reply: async (t, m) => replies.push(m[0]), push: async (u, m) => pushes.push(m), gateway, images, storage, baseUrl: 'https://x.test' });

  await h.command('U1', parseCommand('สร้าง love G2 ทดสอบ'), 'r0');
  await h.postback('U1', parsePostback(replies.at(-1).template.actions[0].data), 'r1');         // A
  await h.command('U1', parseCommand('วิดีโอ สวัสดีครับ'), 'r2');                                // no B yet
  assert.match(replies.at(-1).text, /Gate B/);
  assert.equal(store.state.ledger.length, 0);

  await h.command('U1', parseCommand('ภาพ แมว'), 'r3');
  await h.postback('U1', parsePostback(pushes.at(-1)[2].template.actions[0].data), 'r4');        // B
  await h.command('U1', parseCommand('วิดีโอ หญิง สวัสดีครับ ยินดีต้อนรับสู่ช่องลายออน'), 'r5');
  const out = pushes.at(-1);
  assert.match(out[0].text, /\/vid\/[0-9a-f-]{36}\.mp4/);
  assert.equal(store.state.ledger.length, 3);                                                     // image + voice + render
  const dCard = out[1];
  assert.equal(parsePostback(dCard.template.actions[0].data).gate, 'D');
  await h.command('U1', parseCommand('วิดีโอ หญิง สวัสดีครับ ยินดีต้อนรับสู่ช่องลายออน'), 'r5');  // redelivery
  assert.equal(store.state.ledger.length, 3);

  const vidId = out[0].text.match(/vid\/([0-9a-f-]{36})\.mp4/)[1];
  const asset = await store.getAsset(vidId);
  assert.equal(asset.kind, 'video');
  const size = files.get(asset.r2Key).length;
  const server = makeServer({ secret: 's', allow: new Set(), handlers: {}, images, assets: async (i) => files.get((await store.getAsset(i)).r2Key) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/vid/${vidId}.mp4`;
  const full = await fetch(base);
  assert.deepEqual([full.status, full.headers.get('content-type')], [200, 'video/mp4']);
  const part = await fetch(base, { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  server.close();

  await h.postback('U1', parsePostback(dCard.template.actions[0].data), 'r6');                    // D
  assert.match(replies.at(-1).text, /ผ่าน Gate D/);
  assert.deepEqual((await store.approvedGates(asset.jobId)).sort(), ['A', 'B', 'D']);
});
