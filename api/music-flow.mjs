// LINE flow for the music-led format: song library (R2), lyrics, producing a clip from one excerpt, rendering it.
import crypto from 'node:crypto';
import { parseLyrics, alignLyrics, linesFromLrc, planScenes, parseClock } from '../ops/lyrics.mjs';
import { cutAudio, audioDuration } from '../render/music.mjs';

const text = (t) => ({ type: 'text', text: t });
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const slugOf = (name) => crypto.createHash('sha1').update(name.normalize('NFC')).digest('hex').slice(0, 8);
const INDEX = 'songs/index.json';

export function createMusicFlow({ store, reply, push, gateway, storage, baseUrl, content, planProvider, owners, reasonText, approvalCard, capThb, bySceneIndex, hash, channel = 'love' }) {
  const pending = new Map();      // userId -> { name, at }: the next audio file is that song

  async function readIndex() {
    const b = await storage.get(INDEX);
    try { return b ? JSON.parse(b.toString('utf8')) : { songs: {} }; } catch { return { songs: {} }; }
  }
  const writeIndex = (idx) => storage.put(INDEX, Buffer.from(JSON.stringify(idx)), 'application/json');
  async function find(name) {
    const idx = await readIndex();
    const all = Object.entries(idx.songs);
    const exact = all.filter(([, s]) => s.name === name);
    const hit = exact.length ? exact : all.filter(([, s]) => s.name.includes(name));
    return hit.length === 1 ? { slug: hit[0][0], ...hit[0][1] } : { ambiguous: hit.length > 1, names: hit.map(([, s]) => s.name) };
  }

  async function songName(userId, cmd, replyToken) {
    if (!storage) return reply(replyToken, [text('ต้องตั้งค่า R2 ก่อน')]);
    pending.set(userId, { name: cmd.name, at: Date.now() });
    return reply(replyToken, [text(`ส่งไฟล์เสียงของเพลง "${cmd.name}" มาได้เลย (wav, mp3 หรือ m4a) ภายใน 10 นาที\nระบบจะแปลงเป็น mp3 เก็บไว้ให้`)]);
  }

  /** An audio or file message from the owner: becomes the song named by the last "เพลง <ชื่อ>". */
  async function upload(userId, msg, replyToken) {
    const want = pending.get(userId);
    if (!want || Date.now() - want.at > 10 * 60 * 1000) { pending.delete(userId); return reply(replyToken, [text('ถ้าจะส่งเพลงเข้าระบบ พิมพ์ เพลง <ชื่อเพลง> ก่อน แล้วค่อยส่งไฟล์เสียง')]); }
    if (!storage || !content) return reply(replyToken, [text('การรับเพลงต้องตั้งค่า R2 และ LINE ก่อน')]);
    pending.delete(userId);
    try {
      const raw = await content(msg.id, { maxBytes: 150 * 1024 * 1024 });
      const mp3 = await cutAudio(raw, { mono: false, bitrate: '192k' });
      const seconds = await audioDuration(mp3);
      const slug = slugOf(want.name);
      await storage.put(`songs/${slug}.mp3`, mp3, 'audio/mpeg');
      const idx = await readIndex();
      idx.songs[slug] = { ...(idx.songs[slug] ?? {}), name: want.name, seconds: Math.round(seconds), hasAudio: true };
      await writeIndex(idx);
      return reply(replyToken, [text(`รับเพลง "${want.name}" แล้ว (${fmt(seconds)} นาที, ${(raw.length / 1048576).toFixed(0)} MB เก็บเป็น mp3 ${(mp3.length / 1048576).toFixed(1)} MB)${idx.songs[slug].hasLyrics ? '' : `\nต่อไปส่งเนื้อเพลง: พิมพ์ เนื้อเพลง ${want.name} แล้วขึ้นบรรทัดใหม่ วางเนื้อเพลง`}`)]);
    } catch (err) {
      console.error('song_error', err?.message ?? err);
      return reply(replyToken, [text(`รับเพลงไม่สำเร็จ: ${err?.message === 'clip_too_large' ? 'ไฟล์ใหญ่เกิน 150 MB' : 'ดาวน์โหลดจาก LINE หรือแปลงไฟล์ไม่ได้ ลองส่งเป็น mp3 หรือ m4a'}`)]);
    }
  }

  async function lyrics(userId, cmd, replyToken) {
    if (!storage) return reply(replyToken, [text('ต้องตั้งค่า R2 ก่อน')]);
    const { lines, timed } = parseLyrics(cmd.text);
    if (lines.length < 4) return reply(replyToken, [text('เนื้อเพลงสั้นเกินไป (ต้องมีอย่างน้อย 4 บรรทัด)')]);
    const slug = slugOf(cmd.name);
    await storage.put(`songs/${slug}.lyrics.txt`, Buffer.from(cmd.text, 'utf8'), 'text/plain');
    const idx = await readIndex();
    idx.songs[slug] = { ...(idx.songs[slug] ?? {}), name: cmd.name, hasLyrics: true, timed: Boolean(timed) };
    await writeIndex(idx);
    return reply(replyToken, [text(`บันทึกเนื้อเพลง "${cmd.name}" แล้ว ${lines.length} บรรทัด${timed ? ' (มีเวลากำกับ ใช้จับเวลาได้เลย ไม่ต้องถอดเสียง)' : ''}${idx.songs[slug].hasAudio ? '' : `\nยังไม่มีไฟล์เสียง: พิมพ์ เพลง ${cmd.name} แล้วส่งไฟล์`}`)]);
  }

  async function list(replyToken) {
    if (!storage) return reply(replyToken, [text('ต้องตั้งค่า R2 ก่อน')]);
    const idx = await readIndex();
    const rows = Object.values(idx.songs).map((s) => `${s.name}: ${s.hasAudio ? `เสียง ${fmt(s.seconds ?? 0)}` : 'ยังไม่มีเสียง'}, ${s.hasLyrics ? `เนื้อเพลง${s.timed ? ' (มีเวลา)' : ''}` : 'ยังไม่มีเนื้อเพลง'}`);
    return reply(replyToken, [text(rows.length ? `คลังเพลง\n${rows.join('\n')}\n\nผลิตคลิป: ผลิตเพลง <ชื่อเพลง> <เริ่ม>-<จบ> เช่น ผลิตเพลง นางฟ้าของฉัน 1:20-1:50` : 'ยังไม่มีเพลง พิมพ์ เพลง <ชื่อเพลง> แล้วส่งไฟล์เสียง')]);
  }

  const planText = (plan, cost, src, conf) => {
    const m = plan.music;
    const rows = plan.scenes.map((sc, i) => `${i + 1}. ${fmt(m.bounds[i])}-${fmt(m.bounds[i + 1])} ${[...sc.text.replace(/\n/g, ' / ')].slice(0, 34).join('')}`).join('\n');
    return `แผนงานเพลงนำ: ${m.name}\nท่อน ${fmt(m.start)}-${fmt(m.start + m.bounds.at(-1))} (${Math.round(m.bounds.at(-1))} วินาที) ${plan.scenes.length} ซีน ภาพละไม่เกิน 5 วินาที\nเนื้อเพลง ${m.lines.length} บรรทัด จับเวลาจาก${src === 'lrc' ? 'เวลาที่คุณใส่' : `เสียงร้อง (ความมั่นใจ ${Math.round(conf * 100)}%)`}\nโทนภาพ: ${plan.style ? 'ตามสไตล์ช่อง' : 'ZEN'}\n\n${rows}\n\nค่าวางแผนภาพประมาณ ฿${cost.toFixed(2)}\nถ้าซับไม่ตรงเสียงร้อง ส่งเนื้อเพลงแบบมีเวลา [นาที:วินาที] ต่อบรรทัด แล้วสั่งผลิตใหม่`;
  };

  async function produce(userId, cmd, replyToken) {
    if (!gateway || !push || !storage) return reply(replyToken, [text('ระบบสร้างงานยังไม่ได้ตั้งค่า')]);
    if (!(await store.channelExists(channel))) return reply(replyToken, [text(`ไม่พบช่อง "${channel}"`)]);
    const song = await find(cmd.name);
    if (!song.slug) return reply(replyToken, [text(song.ambiguous ? `ชื่อ "${cmd.name}" ตรงกับหลายเพลง: ${song.names.join(', ')}` : `ไม่พบเพลง "${cmd.name}" พิมพ์ เพลงทั้งหมด เพื่อดูรายการ`)]);
    if (!song.hasAudio || !song.hasLyrics) return reply(replyToken, [text(`เพลง "${song.name}" ยังไม่ครบ: ${!song.hasAudio ? 'ยังไม่มีไฟล์เสียง' : ''}${!song.hasAudio && !song.hasLyrics ? ' และ ' : ''}${!song.hasLyrics ? 'ยังไม่มีเนื้อเพลง' : ''}`)]);
    const from = cmd.from, to = cmd.to, dur = to - from;
    if (!(dur >= 8 && dur <= 90)) return reply(replyToken, [text('ท่อนที่เลือกต้องยาว 8-90 วินาที (แนะนำ 20-45 วินาที)')]);
    if (song.seconds && to > song.seconds + 1) return reply(replyToken, [text(`เพลงนี้ยาว ${fmt(song.seconds)} นาที เลือกท่อนเกินความยาวเพลง`)]);
    const songKey = `songs/${song.slug}.mp3`;
    const lyr = parseLyrics((await storage.get(`songs/${song.slug}.lyrics.txt`))?.toString('utf8') ?? '');
    const jobId = await store.createJob({ channelId: channel, grade: cmd.grade, topic: `${song.name} ${fmt(from)}-${fmt(to)}`, capThb: capThb[cmd.grade], requiresExpert: false, idempotencyKey: `job:${crypto.randomUUID()}` });
    await reply(replyToken, [text(`กำลังจับเวลาเนื้อเพลง "${song.name}" ท่อน ${fmt(from)}-${fmt(to)}${lyr.timed ? '' : ' (ถอดเสียงร้อง ใช้เวลาสักครู่)'}`)]);
    let lines, src, conf = 1, alignCost = 0;
    if (lyr.timed) { lines = linesFromLrc(lyr.timed, from, to); src = 'lrc'; }
    else {
      const a = await gateway.run({ jobId, action: 'align', provider: 'openai-transcribe', actor: 'worker', params: { songKey, start: from, duration: dur }, idempotencyKey: `align:${replyToken}` });
      if (!a.ok) return push(userId, [text(`จับเวลาเนื้อเพลงไม่สำเร็จ: ${reasonText(a)}`)]);
      if (a.replay) return push(userId, [text('คำสั่งนี้ถูกทำไปแล้ว ไม่คิดเงินซ้ำ')]);
      alignCost = a.costThb;
      const r = alignLyrics(lyr.lines, a.result.words);
      lines = r.lines.map((l) => ({ text: l.text, start: l.start, end: l.end })); conf = r.confidence; src = 'stt';
      if (!lines.length) return push(userId, [text(`ถอดเสียงร้องแล้วจับคู่กับเนื้อเพลงไม่ได้ (ความมั่นใจ ${Math.round(conf * 100)}%) อาจเป็นเพราะเสียงร้องปนดนตรีมาก\nทางแก้: ส่งเนื้อเพลงแบบมีเวลา เช่น\n[1:20] บรรทัดแรก\n[1:24] บรรทัดสอง\nแล้วสั่งผลิตใหม่ (ค่าถอดเสียง ฿${alignCost.toFixed(2)})`)]);
    }
    lines = lines.map((l) => ({ text: l.text, start: Math.max(0, +l.start.toFixed(2)), end: Math.min(dur, +l.end.toFixed(2)) })).filter((l) => l.end > l.start);
    if (!lines.length) return push(userId, [text('ไม่พบบรรทัดเนื้อเพลงในช่วงเวลานี้ ตรวจเวลาเริ่ม-จบอีกครั้ง')]);
    const { bounds, scenes } = planScenes(lines, dur);
    const texts = scenes.map((sc) => sc.lines.map((k) => lines[k].text).join('\n'));
    const out = await gateway.run({ jobId, action: 'script', provider: planProvider, actor: 'worker', params: { task: 'music', channel, grade: cmd.grade, title: song.name, scenes: texts }, idempotencyKey: `music:${replyToken}` });
    if (!out.ok) return push(userId, [text(`วางแผนภาพไม่สำเร็จ: ${reasonText(out)}`)]);
    if (out.replay) return push(userId, [text('คำสั่งนี้ถูกทำไปแล้ว ไม่คิดเงินซ้ำ')]);
    const plan = { ...out.result.plan, script: lines.map((l) => l.text).join('\n'), voice: 'female', music: { songKey, name: song.name, start: from, bounds, lines } };
    await store.setPlan(jobId, plan);
    return push(userId, [
      text(planText(plan, out.costThb + alignCost, src, conf)),
      approvalCard(jobId, 'A', `Gate A แผนงานเพลงนำ\n${channel} ${cmd.grade}\n${song.name} ${fmt(from)}-${fmt(to)}\nอนุมัติแล้วระบบสร้างภาพ ${plan.scenes.length} ซีนต่อทันที`),
    ]);
  }

  /** After Gate A + B: render the clip (no voice-over, no ElevenLabs). */
  async function video(userId, job) {
    const scenes = job.plan.scenes, m = job.plan.music;
    const imgs = await bySceneIndex(job.id, 'image');
    if (scenes.some((_, i) => !imgs.has(i))) return push(userId, [text('ยังมีซีนที่ไม่มีภาพ พิมพ์ ซีน <เลข> เพื่อสร้างก่อน')]);
    const clips = await bySceneIndex(job.id, 'clip');
    const dropped = new Set(job.plan.noClip ?? []);
    const sceneParams = scenes.map((_, i) => ({ imageKey: imgs.get(i).r2Key, ...(clips.has(i) && !dropped.has(i) ? { clipKey: clips.get(i).r2Key } : {}) }));
    const sig = hash(`${m.songKey}|${m.start}|${m.bounds.join(',')}|${m.lines.map((l) => `${l.text}@${l.start}`).join(',')}|${sceneParams.map((x) => x.imageKey + (x.clipKey ?? '')).join('|')}`);
    const r = await gateway.run({ jobId: job.id, action: 'render', provider: 'render', actor: 'worker', params: { scenes: sceneParams, music: m, title: job.plan.title }, idempotencyKey: `auto-vid:${job.id}:${sig}` });
    if (!r.ok) return push(userId, [text(`ขั้นเรนเดอร์ไม่สำเร็จ: ${reasonText(r)}\nพิมพ์ ทำวิดีโอ เพื่อลองใหม่`)]);
    if (r.replay) {
      const last = await store.latestAsset(job.id, 'video');
      return push(userId, [text(last ? `วิดีโอนี้ทำไปแล้ว ไม่คิดเงินซ้ำ: ${baseUrl}/vid/${last.id}.mp4` : 'คำสั่งนี้ถูกทำไปแล้ว ไม่คิดเงินซ้ำ')]);
    }
    const videoKey = `jobs/${job.id}/${r.taskId}.mp4`;
    let vidId;
    try { await storage.put(videoKey, r.result.video, 'video/mp4'); vidId = await store.addAsset({ jobId: job.id, r2Key: videoKey, kind: 'video' }); }
    catch (err) { console.error('storage_error', err?.message ?? err); return push(userId, [text('บันทึกวิดีโอไม่สำเร็จ (R2)')]); }
    return push(userId, [
      text(`วิดีโอเพลงนำเสร็จแล้ว (${r.result.seconds.toFixed(1)} วินาที, ${scenes.length} ซีน) ดูที่นี่: ${baseUrl}/vid/${vidId}.mp4\nค่าเรนเดอร์โดยประมาณ ฿${r.costThb.toFixed(2)} (ไม่มีค่าเสียงพากย์)`),
      approvalCard(job.id, 'D', `Gate D ตรวจวิดีโอสุดท้าย\n${job.plan.title}\nอนุมัติก่อนโพสต์`),
    ]);
  }

  return { songName, upload, lyrics, list, produce, video };
}
