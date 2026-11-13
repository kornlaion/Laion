import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { splitLines, buildCues, toAss } from '../render/subtitles.mjs';
import { renderVideo } from '../render/render.mjs';

test('Thai lines break at the author phrase spaces first, then at balanced word boundaries', () => {
  const lines = splitLines('คนเรานะ… ไม่ว่าจะเจออะไรในชีวิต ก็อย่าลืมเป็นคนดี', 16);
  assert.deepEqual(lines, ['คนเรานะ…', 'ไม่ว่าจะเจอ', 'อะไรในชีวิต', 'ก็อย่าลืมเป็นคนดี']);
  const flat = splitLines('สวัสดีครับยินดีต้อนรับสู่ช่องลายออนวันนี้เรามีเรื่องราวดีๆมาฝาก', 14);
  assert.ok(flat.length >= 3);
  for (const l of flat) assert.ok([...l].length <= 17, l);
  assert.equal(flat.join(''), 'สวัสดีครับยินดีต้อนรับสู่ช่องลายออนวันนี้เรามีเรื่องราวดีๆมาฝาก');   // words never lost
});

test('cues cover the whole duration in order; ASS has one event per cue', () => {
  const cues = buildCues('สวัสดีครับยินดีต้อนรับสู่ช่องลายออนวันนี้เรามีเรื่องราวดีๆมาฝากทุกคน', 10, { maxChars: 12 });
  assert.ok(Math.abs(cues.at(-1).end - 10) < 1e-9);
  for (let i = 1; i < cues.length; i++) assert.ok(Math.abs(cues[i].start - cues[i - 1].end) < 1e-9);
  const ass = toAss(cues);
  assert.equal(ass.split('\n').filter((l) => l.startsWith('Dialogue:')).length, cues.length);
});

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

test('real ffmpeg: image + audio + Thai subtitles -> 720x1280 mp4 (default size)', { skip: !hasFfmpeg }, async () => {
  const tmp = fs.mkdtempSync('/tmp/rt-');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'gradients=s=1024x1536:d=1:c0=0x884422:c1=0x224488', '-frames:v', '1', `${tmp}/i.jpg`]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libmp3lame', `${tmp}/a.mp3`]);
  const { video, seconds } = await renderVideo({ image: fs.readFileSync(`${tmp}/i.jpg`), audio: fs.readFileSync(`${tmp}/a.mp3`), text: 'สวัสดีครับ ยินดีต้อนรับสู่ช่องลายออน ราคา 1,250 บาท ผ่าน AI และ EV' });
  fs.writeFileSync(`${tmp}/out.mp4`, video);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', `${tmp}/out.mp4`]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio');
  assert.deepEqual([v.width, v.height, v.codec_name, a.codec_name], [720, 1280, 'h264', 'aac']);
  assert.ok(seconds > 3 && seconds < 4);
  console.log('RENDER_OUT', `${tmp}/out.mp4`);
});

test('aligned cues follow the real speech timing; mismatching alignment falls back to the estimate', () => {
  const text = 'สวัสดีครับ วันนี้อากาศดี\nขอบคุณที่ฟังนะ';
  const chars = [...text].filter((c) => !/\s/.test(c));
  // each non-space char takes 0.1 s, with a 0.5 s pause after the 10th char
  const starts = chars.map((_, i) => i * 0.1 + (i >= 10 ? 0.5 : 0)), ends = starts.map((s) => s + 0.1);
  const align = { characters: chars, starts, ends };
  const cues = buildCues(text, 4, { maxChars: 12, linesPerCue: 1, align });
  assert.ok(cues.length >= 2);
  assert.ok(Math.abs(cues[0].start - 0) < 0.06);
  const second = cues.find((c) => c.start > 1.0);
  assert.ok(second && second.start >= 1.5 - 0.06);                          // starts after the pause, not at an even split
  for (let i = 0; i < cues.length - 1; i++) assert.ok(cues[i].end <= cues[i + 1].start + 1e-9);
  const est = buildCues(text, 4, { maxChars: 12, linesPerCue: 1, align: { characters: ['x'], starts: [0], ends: [1] } });
  assert.equal(est[0].start, 0);                                            // bad alignment: estimated cues (start at 0, even weights)
  assert.equal(est.length, cues.length);
});

test('5-second rule: long scripts get more scenes, every scene fits, words unchanged; owner-chosen count is kept and warned about', async () => {
  const { splitScenes, sceneCount, MAX_SCENE_CHARS } = await import('../render/scenes.mjs');
  const story = ['คนเรานะ… ไม่ว่าจะเจออะไรในชีวิต ก็อย่าลืมเป็นคนดี', 'ต่อให้ต้องถูกหลอกสักกี่ครั้ง ก็อย่าเลือกที่จะไปหลอกใครกลับ', 'และต่อให้ใครจะทำไม่ดีกับเรา ก็อย่าเปลี่ยนตัวเองให้กลายเป็นคนไม่ดีเหมือนเขา', 'เพราะชีวิตคนเรา ไม่ได้แข่งกันว่าใครมีเงินมากกว่ากัน หรือใครประสบความสำเร็จมากกว่ากัน'].join('\n');
  const flat = (x) => x.replace(/\s+/g, '');
  const n = sceneCount([...story].length);
  const scenes = splitScenes(story, n);
  assert.ok(scenes.length >= 6);
  assert.ok(scenes.every((x) => [...flat(x)].length <= MAX_SCENE_CHARS));
  assert.equal(flat(scenes.join('')), flat(story));
  const kept = splitScenes(story, 3, { enforce: false });                // owner supplied 3 prompts: exactly 3 scenes
  assert.equal(kept.length, 3);
  assert.equal(flat(kept.join('')), flat(story));
  assert.ok(sceneCount(100) >= 3 && sceneCount(5000) <= 20);
});
