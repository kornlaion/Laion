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
import { createScriptAdapter, parseWrite, parseVisual } from '../providers/anthropic-script.mjs';
import { parseCommand, parsePostback } from '../api/line.mjs';
import { contactSheet } from '../render/zen.mjs';

const LINES = ['วันหนึ่งฉันเจอเธอที่ริมทะเล', 'แสงอาทิตย์ตกกระทบผิวน้ำ', 'ลมพัดเบา ๆ เหมือนกำลังทักทาย', 'หัวใจก็เต้นแรงขึ้นมาทันที', 'เราเดินเคียงกันโดยไม่พูดอะไร', 'แต่รู้ว่าวันนี้จะอยู่ในใจไปอีกนาน'];
const WRITE = { title: 'รักแรกพบ', script: LINES.join('\n'), voice: 'female' };
const claudeFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  claudeFetch.last = { url, headers: init.headers, body };
  claudeFetch.calls = (claudeFetch.calls ?? 0) + 1;
  const n = Number(/Number of scenes: (\d+)/.exec(body.messages[0].content)?.[1]);
  const out = /art director/.test(body.system)
    ? { title: 'รักแรกพบ', voice: 'female', image_prompts: Array.from({ length: n }, (_, i) => `Quiet sea detail number ${i + 1}, soft light`) }
    : WRITE;
  return { ok: true, json: async () => ({ id: 'msg_1', content: [{ type: 'text', text: '```json\n' + JSON.stringify(out) + '\n```' }] }) };
};

test('parseWrite / parseVisual: tolerate code fences, reject incomplete output', () => {
  assert.equal(parseWrite('```json\n' + JSON.stringify(WRITE) + '\n```').title, 'รักแรกพบ');
  assert.throws(() => parseWrite('no json here'), /script_parse/);
  assert.throws(() => parseWrite(JSON.stringify({ title: 'x' })), /script_incomplete/);
  assert.throws(() => parseWrite(JSON.stringify({ ...WRITE, script: 'ก'.repeat(1001) })), /script_too_long/);
  assert.deepEqual(parseVisual(JSON.stringify({ image_prompts: ['a', 'b'] }), 2).prompts, ['a', 'b']);
  assert.throws(() => parseVisual(JSON.stringify({ image_prompts: ['a'] }), 2), /visual_count_mismatch/);
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
    { provider: 'openai', model: 'gpt-image-2:medium', unit: 'image', priceUsd: 0.08 },
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
  const h = createHandlers({ store, reply: async (t, m) => replies.push(m[0]), push: async (u, m) => pushes.push(m), gateway, images: createImageCache(), storage, baseUrl: 'https://x.test', contactSheet });
  return { store, h, replies, pushes, calls, files };
}

test('produce: script+plan before Gate A; A makes every scene + contact sheet; B makes voices+video; D closes', { skip: !hasFfmpeg }, async () => {
  const { store, h, replies, pushes, calls } = build();
  await h.command('U1', parseCommand('ผลิต love G1 รักแรกพบริมทะเล'), 'r0');
  assert.equal(claudeFetch.last.headers['x-api-key'], 'ak');
  assert.equal(claudeFetch.last.body.model, 'claude-sonnet-5-5');
  assert.match(claudeFetch.last.body.messages[0].content, /Channel: love/);
  const planMsg = pushes.at(-1);
  assert.match(planMsg[0].text, /4 ซีน/);
  assert.equal(store.state.ledger.length, 1);                                         // one script action (2 Claude calls), no image yet
  assert.equal(calls.length, 0);
  const a = parsePostback(planMsg[1].template.actions[0].data);
  assert.equal(a.gate, 'A');

  await h.postback('U1', a, 'r1');                                                    // approve plan -> all scene images automatically
  assert.match(replies.at(-1).text, /กำลังสร้างภาพ 4 ซีน/);
  assert.equal(calls.length, 4);
  assert.match(calls[0].prompt, /Quiet sea detail number \d.*Japanese zen minimalism/);
  assert.equal(calls[0].quality, 'medium');                                           // G1 -> medium
  const sheetPush = pushes.at(-1);
  assert.equal(sheetPush[0].type, 'image');
  assert.match(sheetPush[0].originalContentUrl, /\/img\/[0-9a-f-]{36}\.jpg$/);
  const b = parsePostback(sheetPush[2].template.actions[0].data);
  assert.equal(b.gate, 'B');
  assert.equal(store.state.ledger.length, 5);

  await h.command('U1', { cmd: 'scene', n: 2, prompt: 'A single stone in still water' }, 'r1b');   // redo one scene
  assert.equal(calls.length, 5);
  assert.match(calls.at(-1).prompt, /^A single stone in still water\. Japanese zen/);
  assert.equal(store.state.ledger.length, 6);
  await h.command('U1', { cmd: 'scene', n: 9 }, 'r1c');
  assert.match(replies.at(-1).text, /4 ซีน/);

  await h.postback('U1', b, 'r2');                                                    // approve images -> voices + video
  assert.match(replies.at(-1).text, /กำลังทำวิดีโอ/);
  const urls = calls.filter((c) => c.voiceUrl);
  assert.equal(urls.length, 4);
  assert.match(urls[0].voiceUrl, /speech\/F\?/);                                      // plan said female
  const vid = pushes.at(-1);
  assert.match(vid[0].text, /\/vid\/[0-9a-f-]{36}\.mp4/);
  assert.equal(store.state.ledger.length, 6 + 4 + 1);                                 // + 6 voices + render
  const d = parsePostback(vid[1].template.actions[0].data);
  assert.equal(d.gate, 'D');
  await h.postback('U1', d, 'r3');
  assert.match(replies.at(-1).text, /ผ่าน Gate D/);
  assert.equal(store.jobs.at(-1).state, 'gate_D_ok');

  await h.postback('U1', a, 'r4');                                                    // double tap: nothing runs twice
  await h.command('U1', { cmd: 'makevideo' }, 'r5');                                  // retry: voices reused, render replayed
  assert.equal(store.state.ledger.length, 11);
  assert.match(pushes.at(-1)[0].text, /ไม่คิดเงินซ้ำ/);
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
    const n = Number(/Number of scenes: (\d+)/.exec(JSON.parse(i.body).messages[0].content)?.[1]);
    return { ok: true, json: async () => ({ id: 'm', content: [{ type: 'text', text: JSON.stringify({ title: 'MODEL TITLE', voice: 'male', image_prompts: Array.from({ length: n }, () => 'A calm hill at sunrise'), script: 'MODEL TRIED TO REWRITE' }) }] }) };
  };
  store.createJob; // same store/gateway wiring as build(), but with a custom Claude fetch:
  const g = createGateway({ store, dailyCapThb: 1000, adapters: { anthropic: createScriptAdapter({ apiKey: 'k', fetchImpl: customFetch }) } });
  const h2 = createHandlers({ store, reply: async () => {}, push: async (u, m) => pushes.push(m), gateway: g, images: createImageCache(), baseUrl: 'x' });
  await h2.command('U1', cmd, 'r0');
  assert.match(customFetch.body.system, /art director/);        // only the visual call is made
  assert.equal(store.jobs.at(-1).plan.script, cmd.script);                      // not the model's version
  assert.equal(store.jobs.at(-1).plan.voice, 'male');
  assert.equal(store.jobs.at(-1).plan.title, 'เป็นคนดีไว้ ไม่เสียใจทีหลัง');
  assert.equal(store.jobs.at(-1).plan.scenes.map((x) => x.text).join('\n'), cmd.script.replace(/\n\s*\n/g, '\n'));   // scenes cover the script verbatim
  assert.match(pushes.at(-1)[0].text, /แผนงาน/);
});

test('เขียนเอง with Scene prompts: parsed, no Claude call, prompts used as written, voice line honoured', async () => {
  const lines = ['คนเรานะ… ก็อย่าลืมเป็นคนดี', 'ต่อให้ต้องถูกหลอกสักกี่ครั้ง', 'ก็อย่าเลือกที่จะไปหลอกใครกลับ', 'แต่สิ่งสำคัญคือความสบายใจ', 'ขอบคุณตัวเอง และเป็นกำลังใจให้ทุกคน'];
  const msg = `เขียนเอง love G1 เป็นคนดีไว้\n${lines.join('\n')}\nเสียงชาย\nScene1\nCinematic photo, a man in a cafe,\nrainy window, vertical 9:16\nScene2\nA man walking calmly\nScene3\nDinner with mother\nScene4\nReturning a wallet\nScene 5\nMorning park walk`;
  const cmd = parseCommand(msg);
  assert.equal(cmd.prompts.length, 5);
  assert.equal(cmd.prompts[0], 'Cinematic photo, a man in a cafe, rainy window, vertical 9:16');
  assert.equal(cmd.voice, 'male');
  assert.equal(cmd.script, lines.join('\n'));
  const { store, h, pushes, calls } = build();
  claudeFetch.calls = 0;
  await h.command('U1', cmd, 'r0');
  assert.equal(claudeFetch.calls, 0);
  assert.equal(store.state.ledger.length, 0);
  const plan = store.jobs.at(-1).plan;
  assert.equal(plan.scenes.length, 5);
  assert.equal(plan.scenes[3].image_prompt, 'Returning a wallet');           // no ZEN style appended
  assert.match(pushes.at(-1)[0].text, /ภาพตามพรอมต์ของคุณ/);
  assert.equal(parseCommand(msg.replace('Scene 5\nMorning park walk', '')).prompts.length, 4);
  assert.equal(parseCommand('เขียนเอง love G1 x\n' + lines.join('\n') + '\nScene1\nonly one'), null);
});

test('OpenAI planner: chat completions request shape, JSON mode, plan built, error reason surfaced', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    const n = Number(/Number of scenes: (\d+)/.exec(seen.body.messages[1].content)?.[1]);
    return { ok: true, json: async () => ({ id: 'cmpl_1', choices: [{ message: { content: JSON.stringify({ title: 'ธีม', voice: 'female', image_prompts: Array.from({ length: n }, (_, i) => `p${i}`) }) } }] }) };
  };
  const ad = createScriptAdapter({ vendor: 'openai', apiKey: 'sk-x', fetchImpl });
  const out = await ad.call({ channel: 'love', grade: 'G1', topic: 'เรื่อง', script: LINES.join('\n') });
  assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer sk-x');
  assert.equal(seen.body.model, 'gpt-4.1');
  assert.deepEqual(seen.body.response_format, { type: 'json_object' });
  assert.equal(out.plan.scenes.length, 4);
  assert.match(out.plan.scenes[0].image_prompt, /^p0\. Japanese zen/);
  const bad = createScriptAdapter({ vendor: 'openai', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'model not found' } }) }) });
  await assert.rejects(bad.call({ channel: 'love', grade: 'G1', topic: 't', script: LINES.join('\n') }), /openai_text_400: model not found/);
});

test('งาน and ส่งวิดีโอ: list recent jobs, resend the latest video link', async () => {
  const { h, replies } = build();
  assert.deepEqual(parseCommand('งาน'), { cmd: 'jobs' });
  await h.command('U1', { cmd: 'jobs' }, 'q0');
  assert.match(replies.at(-1).text, /ยังไม่มีงาน/);
  await h.command('U1', { cmd: 'create', channel: 'love', grade: 'G1', topic: 'ทดสอบ' }, 'q1');
  await h.command('U1', { cmd: 'jobs' }, 'q2');
  assert.match(replies.at(-1).text, /love G1 ทดสอบ/);
  assert.deepEqual(parseCommand('ส่งวิดีโอ'), { cmd: 'sendvideo' });
});
