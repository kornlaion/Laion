import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createHandlers } from '../api/app.mjs';
import { createImageCache } from '../api/images.mjs';
import { createGateway } from '../gateway/gateway.mjs';
import { createMemoryStore } from '../gateway/store-memory.mjs';
import { createOpenAIImageAdapter } from '../providers/openai-image.mjs';
import { createElevenLabsAdapter } from '../providers/elevenlabs.mjs';
import { createRenderAdapter } from '../providers/render.mjs';
import { createScriptAdapter, parsePlan } from '../providers/anthropic-script.mjs';
import { parseCommand, parsePostback } from '../api/line.mjs';

const PLAN = { title: 'รักแรกพบ', script: 'วันหนึ่งฉันเจอเธอที่ริมทะเล แสงอาทิตย์ตกกระทบผิวน้ำ และหัวใจก็เต้นแรงขึ้นมาทันที', image_prompt: 'A couple silhouette on a quiet beach at sunset, warm light, vertical', voice: 'female' };
const claudeFetch = async (url, init) => {
  claudeFetch.last = { url, headers: init.headers, body: JSON.parse(init.body) };
  return { ok: true, json: async () => ({ id: 'msg_1', content: [{ type: 'text', text: '```json\n' + JSON.stringify(PLAN) + '\n```' }] }) };
};

test('parsePlan: tolerates code fences, rejects incomplete or too long scripts', () => {
  assert.equal(parsePlan('```json\n' + JSON.stringify(PLAN) + '\n```').title, 'รักแรกพบ');
  assert.throws(() => parsePlan('no json here'), /script_parse/);
  assert.throws(() => parsePlan(JSON.stringify({ script: 'x' })), /script_incomplete/);
  assert.throws(() => parsePlan(JSON.stringify({ ...PLAN, script: 'ก'.repeat(401) })), /script_too_long/);
});

test('parseCommand: produce', () => {
  assert.deepEqual(parseCommand('ผลิต love G1 เพลงรักแรกพบ'), { cmd: 'produce', channel: 'love', grade: 'G1', topic: 'เพลงรักแรกพบ' });
});

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

function build() {
  const tmp = fs.mkdtempSync('/tmp/pt-');
  if (hasFfmpeg) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'gradients=s=1024x1536:d=1', '-frames:v', '1', `${tmp}/i.jpg`]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:a', 'libmp3lame', `${tmp}/a.mp3`]);
  }
  const jpg = hasFfmpeg ? fs.readFileSync(`${tmp}/i.jpg`) : Buffer.from('x'), mp3 = hasFfmpeg ? fs.readFileSync(`${tmp}/a.mp3`) : Buffer.from('x');
  const files = new Map();
  const storage = { put: async (k, b) => files.set(k, b), get: async (k) => files.get(k) ?? null };
  const rates = [
    { provider: 'anthropic', model: 'claude-sonnet-5-5', unit: 'call', priceUsd: 0.02 },
    { provider: 'openai', model: 'gpt-image-2:low', unit: 'image', priceUsd: 0.009 },
    { provider: 'elevenlabs', model: 'eleven_v4', unit: '1k_chars', priceUsd: 0.08 },
    { provider: 'render', model: 'ffmpeg', unit: 'second', priceUsd: 0.0005 },
  ];
  const store = createMemoryStore({ rates });
  const calls = [];
  const gateway = createGateway({ store, dailyCapThb: 1000, adapters: {
    anthropic: createScriptAdapter({ apiKey: 'ak', fetchImpl: claudeFetch }),
    openai: createOpenAIImageAdapter({ apiKey: 'k', fetchImpl: async (u, i) => { calls.push(JSON.parse(i.body)); return { ok: true, json: async () => ({ data: [{ b64_json: jpg.toString('base64') }] }) }; } }),
    elevenlabs: createElevenLabsAdapter({ apiKey: 'k', voiceId: 'D', voices: { female: 'F', male: 'M' }, model: 'eleven_v4', fetchImpl: async (u) => { calls.push({ voiceUrl: u }); return { ok: true, headers: { get: () => null }, arrayBuffer: async () => mp3 }; } }),
    render: createRenderAdapter({ storage }),
  } });
  const replies = [], pushes = [];
  const h = createHandlers({ store, reply: async (t, m) => replies.push(m[0]), push: async (u, m) => pushes.push(m), gateway, images: createImageCache(), storage, baseUrl: 'https://x.test' });
  return { store, h, replies, pushes, calls, files };
}

test('produce: script before Gate A; A approves plan and image is made; B approves and video is made; D closes', { skip: !hasFfmpeg }, async () => {
  const { store, h, replies, pushes, calls } = build();
  await h.command('U1', parseCommand('ผลิต love G1 รักแรกพบริมทะเล'), 'r0');
  assert.equal(claudeFetch.last.headers['x-api-key'], 'ak');
  assert.equal(claudeFetch.last.body.model, 'claude-sonnet-5-5');
  assert.match(claudeFetch.last.body.messages[0].content, /Channel: love/);
  const planMsg = pushes.at(-1);
  assert.match(planMsg[0].text, /สคริปต์/);
  assert.equal(store.state.ledger.length, 1);                                         // script cost recorded, no image yet
  assert.equal(calls.length, 0);
  const a = parsePostback(planMsg[1].template.actions[0].data);
  assert.equal(a.gate, 'A');

  await h.postback('U1', a, 'r1');                                                    // approve plan -> image automatically
  assert.match(replies.at(-1).text, /กำลังสร้างภาพ/);
  assert.match(calls[0].prompt, /silhouette on a quiet beach/);
  assert.equal(calls[0].quality, 'low');                                              // G1 -> low
  const imgPush = pushes.at(-1);
  assert.equal(imgPush[0].type, 'image');
  const b = parsePostback(imgPush[2].template.actions[0].data);
  assert.equal(b.gate, 'B');

  await h.postback('U1', b, 'r2');                                                    // approve image -> video automatically
  assert.match(replies.at(-1).text, /กำลังทำวิดีโอ/);
  assert.match(calls.at(-1).voiceUrl, /speech\/F\?/);                                 // plan said female
  const vid = pushes.at(-1);
  assert.match(vid[0].text, /\/vid\/[0-9a-f-]{36}\.mp4/);
  assert.equal(store.state.ledger.length, 4);                                         // script + image + voice + render
  const d = parsePostback(vid[1].template.actions[0].data);
  assert.equal(d.gate, 'D');
  await h.postback('U1', d, 'r3');
  assert.match(replies.at(-1).text, /ผ่าน Gate D/);
  assert.equal(store.jobs.at(-1).state, 'gate_D_ok');

  await h.postback('U1', a, 'r4');                                                    // double tap: nothing runs twice
  assert.equal(store.state.ledger.length, 4);
});

test('produce on a health channel still drafts the script (no expert gate needed for a draft)', async () => {
  const { store, h, pushes } = build();
  await h.command('U1', parseCommand('ผลิต healthtech G1 เรื่องการนอนหลับ'), 'r0');
  assert.match(pushes.at(-1)[0].text, /แผนงาน/);
  assert.equal(store.jobs[0].requiresExpert, true);
});

test('script failure is reported and not billed', async () => {
  const store = createMemoryStore({ rates: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', unit: 'call', priceUsd: 0.02 }] });
  const pushes = [];
  const gateway = createGateway({ store, dailyCapThb: 1000, adapters: { anthropic: createScriptAdapter({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401 }) }) } });
  const h = createHandlers({ store, reply: async () => {}, push: async (u, m) => pushes.push(m), gateway, images: createImageCache(), baseUrl: 'x' });
  await h.command('U1', parseCommand('ผลิต love G1 ทดสอบ'), 'r0');
  assert.match(pushes.at(-1)[0].text, /ไม่สำเร็จ.*anthropic_401/);
  assert.equal(store.state.ledger.length, 0);
});

test('เขียนเอง: owner script is kept word for word (even over 400 chars), Claude only supplies image prompt + voice', async () => {
  const msg = 'เขียนเอง love G1 เป็นคนดีไว้ ไม่เสียใจทีหลัง\nคนเรานะ… ไม่ว่าจะเจออะไรในชีวิต ก็อย่าลืมเป็นคนดี\n\n' + 'ต่อให้ต้องถูกหลอกสักกี่ครั้ง ก็อย่าเลือกที่จะไปหลอกใครกลับ '.repeat(10);
  const cmd = parseCommand(msg);
  assert.equal(cmd.cmd, 'custom');
  assert.equal(cmd.topic, 'เป็นคนดีไว้ ไม่เสียใจทีหลัง');
  assert.ok([...cmd.script].length > 400 && cmd.script.includes('ก็อย่าลืมเป็นคนดี'));
  assert.equal(parseCommand('เขียนเอง love G1 x\nสั้นไป'), null);          // too short to be a script

  const { store, h, pushes } = build();
  const customFetch = async (u, i) => {
    customFetch.body = JSON.parse(i.body);
    return { ok: true, json: async () => ({ id: 'm', content: [{ type: 'text', text: JSON.stringify({ title: 'เป็นคนดีไว้', image_prompt: 'A calm person at sunrise on a hill, soft light, vertical', voice: 'male', script: 'MODEL TRIED TO REWRITE' }) }] }) };
  };
  store.createJob; // same store/gateway wiring as build(), but with a custom Claude fetch:
  const g = createGateway({ store, dailyCapThb: 1000, adapters: { anthropic: createScriptAdapter({ apiKey: 'k', fetchImpl: customFetch }) } });
  const h2 = createHandlers({ store, reply: async () => {}, push: async (u, m) => pushes.push(m), gateway: g, images: createImageCache(), baseUrl: 'x' });
  await h2.command('U1', cmd, 'r0');
  assert.match(customFetch.body.system, /Do NOT rewrite/);
  assert.equal(store.jobs.at(-1).plan.script, cmd.script);                      // not the model's version
  assert.equal(store.jobs.at(-1).plan.voice, 'male');
  assert.match(pushes.at(-1)[0].text, /แผนงาน/);
});
