import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLyrics, parseClock, alignLyrics, linesFromLrc, planScenes } from '../ops/lyrics.mjs';

const SAMPLE = `[Verse 1]
ฉันไม่เคยได้รู้เลย ที่เธอปิดบังไว้
นางฟ้าบนโลกนี้ ต้องซ่อนปีกเอาไว้

Hook
วันไหนที่อ่อนล้า ขอเธอพักลงตรงนี้
[Chorus] ไม่มีใครพรากเธอไป อยู่เคียงข้างกัน
Final Chorus / Outro
เธอคือนางฟ้าของฉัน คนเดียวเท่านั้น
[นางฟ้าของฉัน KORN AVA](https://suno.com/song/abc)`;

test('parseLyrics drops section tags, links and blanks; keeps words after an inline tag', () => {
  const { lines, timed } = parseLyrics(SAMPLE);
  assert.deepEqual(lines, ['ฉันไม่เคยได้รู้เลย ที่เธอปิดบังไว้', 'นางฟ้าบนโลกนี้ ต้องซ่อนปีกเอาไว้', 'วันไหนที่อ่อนล้า ขอเธอพักลงตรงนี้', 'ไม่มีใครพรากเธอไป อยู่เคียงข้างกัน', 'เธอคือนางฟ้าของฉัน คนเดียวเท่านั้น']);
  assert.equal(timed, null);
});

test('LRC stamps are read and cut to the excerpt', () => {
  const { lines, timed } = parseLyrics('[00:10.50] บรรทัดแรก\n[00:14.00] บรรทัดสอง\n[00:19.20] บรรทัดสาม\n[00:24.00] บรรทัดสี่');
  assert.equal(lines.length, 4);
  const cut = linesFromLrc(timed, 12, 22);
  assert.deepEqual(cut.map((x) => x.text), ['บรรทัดสอง', 'บรรทัดสาม']);
  assert.ok(Math.abs(cut[0].start - 2) < 1e-9 && cut[1].start > cut[0].end - 1e-9);
  assert.equal(parseClock('1:33'), 93); assert.equal(parseClock('93'), 93); assert.equal(parseClock('1:33.5'), 93.5); assert.equal(parseClock('x'), null);
});

// A fake transcript: the singer performs lines 2-4 of a 6-line song; the recogniser mangles tone marks and a few letters.
const LYRICS = ['ฉันอยากเรียนรู้เวทมนตร์ ที่พาเธอลอยผ่านหมู่ดาว', 'นำคำอธิษฐานของเราสองคน ฝากดวงดาวช่วยเก็บเอาไว้', 'ให้เติบโตเคียงข้างแสงจันทร์ เคียงข้างกันเหมือนดั่งความฝัน', 'สองหัวใจสองเราผูกพันกัน บันทึกไว้ผ่านกาลเวลา', 'แม้ใบไม้ที่ร่วงหล่น ยังหวนคิดถึงวันเก่า', 'ฉันยังเก็บทุกเรื่องของเรา ไว้กับดาวบนท้องฟ้าแสนไกล'];
const words = (text, t0, t1) => { const cs = [...text.replace(/\s/g, '')]; const step = (t1 - t0) / cs.length; return cs.map((c, i) => ({ word: c, start: t0 + i * step, end: t0 + (i + 1) * step })); };

test('alignLyrics finds which lines the excerpt covers and times them from the transcript', () => {
  const noisy = (s) => s.replace('เวทมนตร์', 'เวทมนต').replace('อธิษฐาน', 'อธิษถาน');
  const w = [...words(noisy(LYRICS[1]), 1.0, 7.0), ...words(LYRICS[2], 8.0, 15.0), ...words(noisy(LYRICS[3]), 16.0, 22.0)];
  const r = alignLyrics(LYRICS, w);
  assert.ok(r.confidence > 0.8, String(r.confidence));
  assert.deepEqual(r.lines.map((l) => l.index), [1, 2, 3]);
  assert.ok(Math.abs(r.lines[0].start - 1.0) < 0.5 && Math.abs(r.lines[1].start - 8.0) < 0.5 && Math.abs(r.lines[2].end - 22.0) < 0.5);
  for (let i = 1; i < r.lines.length; i++) assert.ok(r.lines[i].start >= r.lines[i - 1].end - 1e-9);
});

test('a silent middle line is interpolated; garbage transcript gives no alignment', () => {
  const w = [...words(LYRICS[0], 0, 6), ...words(LYRICS[2], 12, 18)];                     // line 1 missing from the transcript
  const r = alignLyrics(LYRICS, w);
  assert.deepEqual(r.lines.map((l) => l.index), [0, 1, 2]);
  assert.ok(r.lines[1].start >= 5 && r.lines[1].end <= 12.1 && r.lines[1].start < r.lines[1].end);
  const bad = alignLyrics(LYRICS, words('qqqqqwwwwweeeeerrrrr', 0, 10));
  assert.equal(bad.lines.length, 0);
});

test('planScenes: a picture change at each line, never over 5 s, never under 2.5 s, whole excerpt covered', () => {
  const lines = [{ text: 'a', start: 1, end: 4 }, { text: 'b', start: 4.5, end: 7 }, { text: 'c', start: 7.4, end: 9 }, { text: 'd', start: 16, end: 20 }];
  const { bounds, scenes } = planScenes(lines, 24);
  assert.equal(bounds[0], 0); assert.equal(bounds.at(-1), 24);
  for (let i = 1; i < bounds.length; i++) { const d = bounds[i] - bounds[i - 1]; assert.ok(d <= 5.0001 && d >= 2.4, `scene ${i} is ${d}s`); }
  assert.equal(scenes.length, bounds.length - 1);
  const claimed = scenes.flatMap((s) => s.lines).sort();
  assert.deepEqual(claimed, [0, 1, 2, 3]);                                                  // every line belongs to exactly one scene
});
