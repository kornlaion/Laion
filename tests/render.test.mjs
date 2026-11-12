import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { splitLines, buildCues, toAss } from '../render/subtitles.mjs';
import { renderVideo } from '../render/render.mjs';

test('Thai lines break between words and respect the limit', () => {
  const lines = splitLines('สวัสดีครับยินดีต้อนรับสู่ช่องลายออนวันนี้เรามีเรื่องราวดีๆมาฝาก', 14);
  assert.ok(lines.length >= 3);
  for (const l of lines) assert.ok([...l].length <= 16, l);
  assert.equal(lines.join(''), 'สวัสดีครับยินดีต้อนรับสู่ช่องลายออนวันนี้เรามีเรื่องราวดีๆมาฝาก');
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

test('real ffmpeg: image + audio + Thai subtitles -> 1080x1920 mp4', { skip: !hasFfmpeg }, async () => {
  const tmp = fs.mkdtempSync('/tmp/rt-');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'gradients=s=1024x1536:d=1:c0=0x884422:c1=0x224488', '-frames:v', '1', `${tmp}/i.jpg`]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libmp3lame', `${tmp}/a.mp3`]);
  const { video, seconds } = await renderVideo({ image: fs.readFileSync(`${tmp}/i.jpg`), audio: fs.readFileSync(`${tmp}/a.mp3`), text: 'สวัสดีครับ ยินดีต้อนรับสู่ช่องลายออน ราคา 1,250 บาท ผ่าน AI และ EV' });
  fs.writeFileSync(`${tmp}/out.mp4`, video);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', `${tmp}/out.mp4`]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio');
  assert.deepEqual([v.width, v.height, v.codec_name, a.codec_name], [1080, 1920, 'h264', 'aac']);
  assert.ok(seconds > 3 && seconds < 4);
  console.log('RENDER_OUT', `${tmp}/out.mp4`);
});
