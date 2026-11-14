import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createHandlers } from '../api/app.mjs';
import { createImageCache } from '../api/images.mjs';
import { createGateway } from '../gateway/gateway.mjs';
import { createMemoryStore } from '../gateway/store-memory.mjs';
import { createOpenAIImageAdapter } from '../providers/openai-image.mjs';
import { createRenderAdapter } from '../providers/render.mjs';
import { createScriptAdapter } from '../providers/anthropic-script.mjs';
import { createTranscribeAdapter } from '../providers/openai-transcribe.mjs';
import { parseCommand, parsePostback } from '../api/line.mjs';
import { contactSheet } from '../render/zen.mjs';

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

const LYRICS = `[Verse 1]
ฉันอยากเรียนรู้เวทมนตร์ ที่พาเธอลอยผ่านหมู่ดาว
นำคำอธิษฐานของเราสองคน ฝากดวงดาวช่วยเก็บเอาไว้
ให้เติบโตเคียงข้างแสงจันทร์ เคียงข้างกันเหมือนดั่งความฝัน
สองหัวใจสองเราผูกพันกัน บันทึกไว้ผ่านกาลเวลา
[Chorus]
ฉันจะรอ รอหมู่ดอกไม้ผลิบาน รอฤดูกาลที่พ้นผ่าน
รอคืนวันที่โชคชะตาพาเรามาพบกัน
ฉันจะจับมือเธอไว้ พาไปบนฟ้าที่กว้างใหญ่
ให้หมู่ดาวได้เป็นพยานของหัวใจ`;

test('parseCommand: song commands', () => {
  assert.deepEqual(parseCommand('เพลง นางฟ้าของฉัน'), { cmd: 'songname', name: 'นางฟ้าของฉัน' });
  assert.deepEqual(parseCommand('เพลงทั้งหมด'), { cmd: 'songs' });
  assert.deepEqual(parseCommand('ผลิตเพลง นางฟ้าของฉัน 1:20-1:50'), { cmd: 'musicproduce', name: 'นางฟ้าของฉัน', from: 80, to: 110, grade: 'G1' });
  assert.deepEqual(parseCommand('ผลิตเพลง ฉันจะรอเธอ 93-120 G0'), { cmd: 'musicproduce', name: 'ฉันจะรอเธอ', from: 93, to: 120, grade: 'G0' });
  assert.equal(parseCommand('ผลิตเพลง x 2:00-1:00'), null);
  const l = parseCommand(`เนื้อเพลง นางฟ้าของฉัน\n${LYRICS}`);
  assert.equal(l.cmd, 'lyrics'); assert.equal(l.name, 'นางฟ้าของฉัน'); assert.match(l.text, /^\[Verse 1\]/);
});

test('music-led clip end to end: song upload -> lyrics -> plan (timed from the singing) -> images -> video with the song as soundtrack -> Gate D', { skip: !hasFfmpeg }, async () => {
  const tmp = fs.mkdtempSync('/tmp/mu-');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'gradients=s=1024x1536:d=1', '-frames:v', '1', `${tmp}/i.jpg`]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=120', `${tmp}/song.wav`]);
  const jpg = fs.readFileSync(`${tmp}/i.jpg`), wav = fs.readFileSync(`${tmp}/song.wav`);
  const files = new Map();
  const storage = { put: async (k, b) => files.set(k, b), get: async (k) => files.get(k) ?? null };
  const store = createMemoryStore({ rates: [
    { provider: 'openai-text', model: 'gpt-4.1', unit: 'call', priceUsd: 0.02 },
    { provider: 'openai-transcribe', model: 'whisper-1', unit: 'call', priceUsd: 0.01 },
    { provider: 'openai', model: 'gpt-image-2:medium', unit: 'image', priceUsd: 0.08 }, { provider: 'openai', model: 'gpt-image-2:low', unit: 'image', priceUsd: 0.009 },
    { provider: 'render', model: 'ffmpeg', unit: 'second', priceUsd: 0.0005 },
  ] });
  // the "recogniser" hears lines 2-4 of the verse sung between 3 s and 20 s of the excerpt
  const sung = ['นำคำอธิษฐานของเราสองคน ฝากดวงดาวช่วยเก็บเอาไว้', 'ให้เติบโตเคียงข้างแสงจันทร์ เคียงข้างกันเหมือนดั่งความฝัน', 'สองหัวใจสองเราผูกพันกัน บันทึกไว้ผ่านกาลเวลา'];
  const words = sung.flatMap((t, k) => [...t.replace(/\s/g, '')].map((c, i, a) => ({ word: c, start: 3 + k * 6 + (i * 5) / a.length, end: 3 + k * 6 + ((i + 1) * 5) / a.length })));
  let transcribed = 0;
  const transcribe = { unit: 'call', model: () => 'whisper-1', units: () => 1, call: async (p) => { transcribed++; assert.equal(p.start, 80); assert.equal(p.duration, 30); return { words }; } };
  let plannerBody;
  const planner = createScriptAdapter({ vendor: 'openai', apiKey: 'k', fetchImpl: async (u, i) => { plannerBody = JSON.parse(i.body); const n = Number(/Number of scenes: (\d+)/.exec(plannerBody.messages[1].content)[1]); return { ok: true, json: async () => ({ id: 'c1', choices: [{ message: { content: JSON.stringify({ image_prompts: Array.from({ length: n }, (_, k) => `Night sky over a quiet city, detail ${k + 1}`) }) } }] }) }; } });
  const imgCalls = [];
  const gateway = createGateway({ store, dailyCapThb: 1000, adapters: {
    'openai-text': planner, 'openai-transcribe': transcribe,
    openai: createOpenAIImageAdapter({ apiKey: 'k', fetchImpl: async (u, i) => { imgCalls.push(JSON.parse(i.body)); return { ok: true, json: async () => ({ data: [{ b64_json: jpg.toString('base64') }] }) }; } }),
    render: createRenderAdapter({ storage }),
  } });
  const replies = [], pushes = [];
  const h = createHandlers({ store, reply: async (t, m) => replies.push(m[0]), push: async (u, m) => pushes.push(m), gateway, images: createImageCache(), storage, baseUrl: 'https://x.test', contactSheet,
    planProvider: 'openai-text', owners: ['U1'], content: async (id, opts) => { assert.equal(id, 'msg1'); assert.ok(opts.maxBytes > 100e6); return wav; } });

  await h.song('U1', { id: 'msg1', type: 'file' }, 's0');                                   // a file without saying which song
  assert.match(replies.at(-1).text, /พิมพ์ เพลง <ชื่อเพลง> ก่อน/);
  await h.command('U1', parseCommand('เพลง นางฟ้าของฉัน'), 's1');
  await h.song('U1', { id: 'msg1', type: 'file' }, 's2');
  assert.match(replies.at(-1).text, /รับเพลง "นางฟ้าของฉัน" แล้ว \(2:00 นาที/);
  assert.ok([...files.keys()].some((k) => /^songs\/[0-9a-f]{8}\.mp3$/.test(k)));
  await h.command('U1', parseCommand(`เนื้อเพลง นางฟ้าของฉัน\n${LYRICS}`), 's3');
  assert.match(replies.at(-1).text, /8 บรรทัด/);
  await h.command('U1', parseCommand('เพลงทั้งหมด'), 's4');
  assert.match(replies.at(-1).text, /นางฟ้าของฉัน: เสียง 2:00, เนื้อเพลง/);

  await h.command('U1', parseCommand('ผลิตเพลง นางฟ้า 1:20-1:50 G1'), 's5');            // partial name is enough
  assert.equal(transcribed, 1);
  assert.match(plannerBody.messages[1].content, /Number of scenes: \d+/);
  const planMsg = pushes.at(-1);
  assert.match(planMsg[0].text, /แผนงานเพลงนำ: นางฟ้าของฉัน/);
  assert.match(planMsg[0].text, /1:20-1:50 \(30 วินาที\)/);
  assert.match(planMsg[0].text, /จับเวลาจากเสียงร้อง/);
  const job = store.jobs.at(-1);
  const m = job.plan.music;
  assert.equal(m.lines.length, 3);
  assert.ok(Math.abs(m.lines[0].start - 3) < 0.6);
  for (let i = 1; i < m.bounds.length; i++) assert.ok(m.bounds[i] - m.bounds[i - 1] <= 5.0001, 'every picture stays at most 5 s');
  assert.equal(m.bounds.at(-1), 30);
  assert.match(job.plan.scenes[0].image_prompt, /cinematic romantic mood/);                // KORN AVA picture style, not zen
  const a = parsePostback(planMsg[1].template.actions[0].data);
  assert.equal(a.gate, 'A');

  await h.postback('U1', a, 'r1');
  assert.equal(imgCalls.length, job.plan.scenes.length);
  const sheet = pushes.at(-1);
  const b = parsePostback(sheet.at(-1).template.actions[0].data);
  assert.equal(b.gate, 'B');
  await h.postback('U1', b, 'r2');
  const vid = pushes.at(-1);
  assert.match(vid[0].text, /วิดีโอเพลงนำเสร็จแล้ว \(30\.0 วินาที/);
  const mp4 = [...files.entries()].find(([k]) => k.endsWith('.mp4'))[1];
  fs.writeFileSync(`${tmp}/out.mp4`, mp4);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', `${tmp}/out.mp4`]).toString());
  assert.ok(Math.abs(Number(probe.format.duration) - 30) < 0.4);
  assert.ok(probe.streams.some((s) => s.codec_type === 'audio'));
  const d = parsePostback(vid[1].template.actions[0].data);
  assert.equal(d.gate, 'D');
  const before = store.state.ledger.length;
  await h.command('U1', { cmd: 'makevideo' }, 'r3');                                        // retry reuses everything, nothing charged again
  assert.equal(store.state.ledger.length, before);
  assert.match(pushes.at(-1)[0].text, /ไม่คิดเงินซ้ำ/);
  console.log('MUSIC_E2E_OUT', `${tmp}/out.mp4`);
});

test('timed lyrics (LRC) skip the transcription; unmatched transcript asks for timed lyrics', { skip: !hasFfmpeg }, async () => {
  const tmp = fs.mkdtempSync('/tmp/mu2-');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=60', `${tmp}/s.wav`]);
  const wav = fs.readFileSync(`${tmp}/s.wav`);
  const files = new Map();
  const storage = { put: async (k, b) => files.set(k, b), get: async (k) => files.get(k) ?? null };
  const store = createMemoryStore({ rates: [{ provider: 'openai-text', model: 'x', unit: 'call', priceUsd: 0.02 }, { provider: 'openai-transcribe', model: 'whisper-1', unit: 'call', priceUsd: 0.01 }] });
  let heard = [{ word: 'qqqqqwwwwweeeeerrrrrtttt', start: 1, end: 9 }];
  const gateway = createGateway({ store, dailyCapThb: 1000, adapters: {
    'openai-transcribe': { unit: 'call', model: () => 'whisper-1', units: () => 1, call: async () => ({ words: heard }) },
    'openai-text': { unit: 'call', model: () => 'x', units: () => 1, call: async (p) => ({ plan: { title: p.title, style: 's', scenes: p.scenes.map((t) => ({ text: t || '♪', visual: 'v', image_prompt: 'v. s' })) } }) },
  } });
  const replies = [], pushes = [];
  const h = createHandlers({ store, reply: async (t, m) => replies.push(m[0]), push: async (u, m) => pushes.push(m), gateway, images: createImageCache(), storage, baseUrl: 'https://x.test', contactSheet, planProvider: 'openai-text', owners: ['U1'], content: async () => wav });
  await h.command('U1', parseCommand('เพลง ทดสอบ'), '1'); await h.song('U1', { id: 'm' }, '2');
  await h.command('U1', parseCommand(`เนื้อเพลง ทดสอบ\n${LYRICS}`), '3');
  await h.command('U1', parseCommand('ผลิตเพลง ทดสอบ 0:10-0:40'), '4');                  // garbage transcript
  assert.match(pushes.at(-1)[0].text, /ถอดเสียงร้องแล้วจับคู่กับเนื้อเพลงไม่ได้/);
  const timedLyrics = LYRICS.split('\n').filter((l) => !l.startsWith('[')).map((l, i) => `[0:${String(12 + i * 4).padStart(2, '0')}.0] ${l}`).join('\n');
  await h.command('U1', parseCommand(`เนื้อเพลง ทดสอบ\n${timedLyrics}`), '5');
  assert.match(replies.at(-1).text, /มีเวลากำกับ/);
  const ledger = store.state.ledger.length;
  await h.command('U1', parseCommand('ผลิตเพลง ทดสอบ 0:10-0:40'), '6');                  // no transcription this time
  assert.match(pushes.at(-1)[0].text, /จับเวลาจากเวลาที่คุณใส่/);
  assert.equal(store.state.ledger.length, ledger + 1);                                     // only the planning call was charged
  await h.command('U1', parseCommand('ผลิตเพลง ทดสอบ 0:10-0:15'), '7');
  assert.match(replies.at(-1).text, /8-90 วินาที/);
  await h.command('U1', parseCommand('ผลิตเพลง ไม่มีเพลงนี้ 0:10-0:40'), '8');
  assert.match(replies.at(-1).text, /ไม่พบเพลง/);
});

test('only the active channels can be produced or researched (phase 1: love)', async () => {
  const { createMemoryStore: mk } = await import('../gateway/store-memory.mjs');
  const { startScheduler } = await import('../ops/digest.mjs');
  const store = mk({ rates: [] });
  const replies = [];
  const h = createHandlers({ store, reply: async (t, m) => replies.push(m[0]), push: async () => {}, gateway: {}, activeChannels: new Set(['love']), owners: ['U1'], research: async () => ({ ok: true }) });
  await h.command('U1', parseCommand('ผลิต pet G1 หัวข้อทดสอบ'), '1');
  assert.match(replies.at(-1).text, /ช่อง "pet" ยังไม่เปิดใช้งาน ตอนนี้เปิดเฉพาะ: love/);
  await h.command('U1', parseCommand('ไอเดีย healthtech'), '2');
  assert.match(replies.at(-1).text, /ยังไม่เปิดใช้งาน/);
  await h.command('U1', parseCommand('ไอเดียใหม่ energy-ai'), '3');
  assert.match(replies.at(-1).text, /ยังไม่เปิดใช้งาน/);
  const asked = [];
  const sched = startScheduler({ store: { ...store, wasDone: async () => false, markDone: async () => {}, spentTodayThb: async () => 0, summary: async () => ({ total: 0, byState: {}, spentToday: 0 }), stuckJobs: async () => [], listChannels: async () => ['love', 'mindbody', 'energy-ai', 'healthtech', 'pet'] },
    push: async () => {}, owners: ['U1'], dailyCapThb: 1000, channels: ['love'], research: async (ch) => { asked.push(ch); return { ok: true, count: 10 }; }, now: () => new Date('2026-11-14T02:00:00Z') });
  await sched.tick(); sched.stop();
  assert.deepEqual(asked, ['love']);
});
