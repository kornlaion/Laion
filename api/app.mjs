import crypto from 'node:crypto';
import { GRADE_CAP_THB } from '../gateway/policy.mjs';
import { STYLE_ZEN } from '../providers/anthropic-script.mjs';
import { splitScenes, sceneSeconds, MAX_SCENE_CHARS } from '../render/scenes.mjs';
import { MODES, DEFAULT_MODE, estimateSeconds } from '../render/formats.mjs';
import { createMusicFlow } from './music-flow.mjs';

// Lane D channels (health / wellbeing) need expert Gate C before video, voice and publish.
const EXPERT_CHANNELS = new Set(['mindbody', 'healthtech']);

const text = (t) => ({ type: 'text', text: t });

/** Approval card with three postback buttons. Label max 20 chars, body max 160 (LINE limits). */
const todayBkk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

/** Carousel of topic ideas (one column per idea; LINE allows 10 columns, 3 buttons each, text up to 120 chars with a title). */
export function ideasCarousel(ideas) {
  return {
    type: 'template', altText: 'ไอเดียหัวข้อวันนี้',
    template: {
      type: 'carousel',
      columns: ideas.slice(0, 10).map((x) => ({
        // LINE: with a title the text may be only 60 characters, without a title 120 - so the title goes inside the text.
        text: `${x.rank}. ${x.title}\n${x.hook || ''}`.slice(0, 120),
        actions: [
          { type: 'postback', label: 'ผลิตเรื่องนี้', data: `idea:${x.id}:make` },
          { type: 'postback', label: 'แหล่งที่มา', data: `idea:${x.id}:src` },
          { type: 'postback', label: 'ข้าม', data: `idea:${x.id}:skip` },
        ],
      })),
    },
  };
}

export function approvalCard(jobId, gate, body) {
  const nonce = crypto.randomBytes(4).toString('hex');
  const btn = (label, decision) => ({ type: 'postback', label, data: `gate:${jobId}:${gate}:${decision}:${nonce}` });
  return {
    type: 'template',
    altText: `ขออนุมัติ Gate ${gate}`,
    template: { type: 'buttons', text: body.slice(0, 160), actions: [btn('อนุมัติ', 'approve'), btn('แก้ไข', 'revise'), btn('ยกเลิก', 'reject')] },
  };
}

const REASONS = {
  no_rate: 'ยังไม่มีราคาของโมเดลนี้ในตาราง provider_rates',
  kill_switch_system: 'ระบบถูกพักอยู่ (พิมพ์ เริ่ม all)',
  kill_switch_channel: 'ช่องนี้ถูกพักอยู่',
  kill_switch_provider: 'ผู้ให้บริการนี้ถูกพักอยู่',
  job_cap_exceeded: 'เกินเพดานงบของงานนี้',
  daily_cap_exceeded: 'เกินเพดานงบรายวัน',
  provider_error: 'ผู้ให้บริการตอบผิดพลาด',
};

export function createHandlers({ store, reply, push, gateway, images, storage, baseUrl, contactSheet, planProvider = 'anthropic', experts = new Set(), owners = [], content, research, activeChannels = null, dailyCapThb = Number(process.env.DAILY_CAP_THB ?? 1000) }) {
  // Only these channels may be produced or researched (null = all). Phase 1: KORN AVA (love) only.
  const notActive = (ch) => (activeChannels && !activeChannels.has(ch) ? `ช่อง "${ch}" ยังไม่เปิดใช้งาน ตอนนี้เปิดเฉพาะ: ${[...activeChannels].join(', ')}` : null);
  const reasonText = (out) => `${REASONS[out.reason] ?? (out.reason.startsWith('gate_missing') ? 'ยังไม่ผ่านด่านอนุมัติที่จำเป็น' : out.reason)}${out.reason === 'provider_error' && out.message ? ` (${out.message})` : ''}`;

  /** Saves to R2 (permanent) when configured, else the temporary in-memory cache. Returns the id used in the URL. */
  async function saveFile(job, out, buf, contentType, ext, kind) {
    if (storage) {
      try {
        const key = `jobs/${job.id}/${out.taskId}.${ext}`;
        await storage.put(key, buf, contentType);
        return await store.addAsset({ jobId: job.id, r2Key: key, kind });
      } catch (err) { console.error('storage_error', err?.message ?? err); }
    }
    return images.put(buf);
  }

  const NO_JOB = 'ยังไม่มีงานที่ผ่าน Gate A ให้พิมพ์ ผลิต <ช่อง> <เกรด> <หัวข้อ> แล้วกดอนุมัติก่อน';
  const latestA = () => store.latestApprovedJob('A');
  const QUALITY = { G0: 'low', G1: 'medium', G2: 'medium', G3: 'high', G4: 'high' };
  const done = (out) => (out.replay ? text('คำสั่งนี้ถูกทำไปแล้ว ไม่คิดเงินซ้ำ') : null);

  async function doImage(userId, job, { prompt, quality, key }) {
    const out = await gateway.run({ jobId: job.id, action: 'image', provider: 'openai', params: { prompt, quality }, idempotencyKey: key, actor: 'worker' });
    if (!out.ok) return push(userId, [text(`สร้างภาพไม่สำเร็จ: ${reasonText(out)}`)]);
    if (out.replay) return push(userId, [done(out)]);
    const url = `${baseUrl}/img/${await saveFile(job, out, out.result.images[0], 'image/jpeg', 'jpg', 'image')}.jpg`;
    const gateB = (await store.hasApproval(job.id, 'B'))
      ? []
      : [approvalCard(job.id, 'B', `Gate B ตรวจภาพ\n${job.topic}\nอนุมัติแล้วระบบทำวิดีโอต่อ`)];
    return push(userId, [
      { type: 'image', originalContentUrl: url, previewImageUrl: url },
      text(`เสร็จแล้ว ค่าใช้จ่ายโดยประมาณ ฿${out.costThb.toFixed(2)}${out.warn ? ' (ใกล้เพดานงบ)' : ''}\nราคาจริงดูที่ OpenAI Usage`),
      ...gateB,
    ]);
  }

  async function doVoiceOnly(userId, job, { text: t, voice, key }) {
    const out = await gateway.run({ jobId: job.id, action: 'voice', provider: 'elevenlabs', params: { text: t, voice }, idempotencyKey: key, actor: 'worker' });
    if (!out.ok) return push(userId, [text(`สร้างเสียงไม่สำเร็จ: ${reasonText(out)}`)]);
    if (out.replay) return push(userId, [done(out)]);
    const url = `${baseUrl}/aud/${await saveFile(job, out, out.result.audio, 'audio/mpeg', 'mp3', 'voice')}.mp3`;
    return push(userId, [text(`เสร็จแล้ว ฟังที่นี่: ${url}\nค่าใช้จ่ายโดยประมาณ ฿${out.costThb.toFixed(2)}\nราคาจริงดูที่ ElevenLabs Usage`)]);
  }

  /** Returns a Thai message when the job is not ready for video, otherwise null. */
  async function videoPrecheck(job) {
    if (!(await store.approvedGates(job.id)).includes('B')) return 'ต้องผ่าน Gate B (อนุมัติภาพ) ก่อนทำวิดีโอ';
    if (!(await store.latestAsset(job.id, 'image'))) return 'งานนี้ยังไม่มีภาพที่เก็บถาวร พิมพ์ ภาพ ... ก่อน';
    return null;
  }

  async function doVideo(userId, job, { text: t, voice, key }) {
    const img = await store.latestAsset(job.id, 'image');
    const v = await gateway.run({ jobId: job.id, action: 'voice', provider: 'elevenlabs', params: { text: t, voice }, idempotencyKey: `vid-voice:${key}`, actor: 'worker' });
    if (!v.ok) return push(userId, [text(`ขั้นเสียงไม่สำเร็จ: ${reasonText(v)}`)]);
    if (v.replay) return push(userId, [done(v)]);
    const audioKey = `jobs/${job.id}/${v.taskId}.mp3`;
    try { await storage.put(audioKey, v.result.audio, 'audio/mpeg'); await store.addAsset({ jobId: job.id, r2Key: audioKey, kind: 'voice' }); }
    catch (err) { console.error('storage_error', err?.message ?? err); return push(userId, [text('บันทึกไฟล์เสียงไม่สำเร็จ (R2)')]); }

    const r = await gateway.run({ jobId: job.id, action: 'render', provider: 'render', params: { imageKey: img.r2Key, audioKey, text: t }, idempotencyKey: `vid-render:${key}`, actor: 'worker' });
    if (!r.ok) return push(userId, [text(`ขั้นเรนเดอร์ไม่สำเร็จ: ${reasonText(r)}`)]);
    if (r.replay) return push(userId, [done(r)]);
    const videoKey = `jobs/${job.id}/${r.taskId}.mp4`;
    let vidId;
    try { await storage.put(videoKey, r.result.video, 'video/mp4'); vidId = await store.addAsset({ jobId: job.id, r2Key: videoKey, kind: 'video' }); }
    catch (err) { console.error('storage_error', err?.message ?? err); return push(userId, [text('บันทึกวิดีโอไม่สำเร็จ (R2)')]); }
    const total = v.costThb + r.costThb;
    return push(userId, [
      text(`วิดีโอเสร็จแล้ว (${r.result.seconds.toFixed(1)} วินาที) ดูที่นี่: ${baseUrl}/vid/${vidId}.mp4\nค่าใช้จ่ายโดยประมาณ ฿${total.toFixed(2)} (เสียง ฿${v.costThb.toFixed(2)} + เรนเดอร์ ฿${r.costThb.toFixed(2)})`),
      approvalCard(job.id, 'D', `Gate D ตรวจวิดีโอสุดท้าย\n${job.topic}\nอนุมัติก่อนโพสต์`),
    ]);
  }



  const pendingClip = new Map();   // userId -> { jobId, n, at }: the next video the user sends becomes this scene's clip

  // ---------- Gate C (expert review) for health/wellbeing channels ----------
  const needsC = (job) => job.requiresExpert;
  const cOk = async (job) => !needsC(job) || (await store.approvedGates(job.id)).includes('C');
  const WAIT_C = 'ช่องนี้ต้องให้ผู้เชี่ยวชาญตรวจเนื้อหา (Gate C) ก่อนทำเสียงและวิดีโอ ระบบส่งให้ผู้เชี่ยวชาญแล้ว เมื่ออนุมัติจะทำต่อให้อัตโนมัติ (ถ้าผ่าน Gate B แล้ว)';

  async function notifyExperts(job, plan) {
    if (!needsC(job) || !push || experts.size === 0) return false;
    const body = `ขอให้ตรวจเนื้อหา (ช่อง ${job.channelId})\nหัวข้อ: ${plan.title}\n\nสคริปต์:\n${plan.script}\n\nโปรดตรวจว่าเป็นข้อมูลทั่วไป ไม่มีคำแนะนำทางการแพทย์ การวินิจฉัย หรือคำกล่าวอ้างสรรพคุณ`;
    for (const id of experts) {
      try { await push(id, [text(body), approvalCard(job.id, 'C', `Gate C ผู้เชี่ยวชาญ\n${plan.title}\nตรวจสคริปต์แล้วกดผล`)]); }
      catch (err) { console.error('expert_push_error', err?.message ?? err); }
    }
    return true;
  }
  const tellOwners = async (msgs) => { for (const id of owners) { try { await push(id, msgs); } catch (err) { console.error('owner_push_error', err?.message ?? err); } } };

  // ---------- publish pack: captions for the four platforms, to post by hand until the platform APIs are connected ----------
  const packText = (plan, c, videoUrl) => {
    const tags = (a) => a.map((h) => `#${h}`).join(' ');
    return [
      `ชุดโพสต์: ${plan.title}`, videoUrl ? `ไฟล์วิดีโอ: ${videoUrl}` : '', '',
      `TikTok\n${c.tiktok.caption}\n${tags(c.tiktok.hashtags)}`, '',
      `Instagram Reels\n${c.instagram.caption}\n${tags(c.instagram.hashtags)}`, '',
      `YouTube Shorts\nชื่อ: ${c.youtube.title}\n${c.youtube.description}\n${tags(c.youtube.hashtags)}`, '',
      `Facebook Reels\n${c.facebook.caption}\n${tags(c.facebook.hashtags)}`, '',
      'อย่าลืมติดป้ายเนื้อหาที่สร้างหรือแก้ไขด้วย AI ตามเงื่อนไขของแต่ละแพลตฟอร์ม และตรวจกติกาความยาว/รูปแบบล่าสุดก่อนโพสต์',
      '(ระบบยังไม่โพสต์อัตโนมัติ จนกว่าจะเชื่อมแพลตฟอร์ม)',
    ].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
  };

  async function doPublishPack(userId, job, { force = false, key } = {}) {
    const video = await store.latestAsset(job.id, 'video');
    const url = video ? `${baseUrl}/vid/${video.id}.mp4` : '';
    if (job.plan.captions && !force) return push(userId, [text(packText(job.plan, job.plan.captions, url))]);
    const out = await gateway.run({ jobId: job.id, action: 'caption', provider: planProvider, actor: 'worker',
      params: { task: 'caption', channel: job.channelId, title: job.plan.title, script: job.plan.script }, idempotencyKey: key ?? `caption:${job.id}` });
    if (!out.ok) return push(userId, [text(`สร้างแคปชันไม่สำเร็จ: ${reasonText(out)}\nพิมพ์ แคปชัน เพื่อลองใหม่`)]);
    if (out.replay) return push(userId, [text(job.plan.captions ? packText(job.plan, job.plan.captions, url) : 'ชุดแคปชันถูกสร้างไปแล้ว พิมพ์ แคปชัน เพื่อสร้างใหม่')]);
    job.plan.captions = out.result.captions;
    await store.setPlan(job.id, job.plan);
    return push(userId, [text(`${packText(job.plan, out.result.captions, url)}\n\nค่าแคปชันโดยประมาณ ฿${out.costThb.toFixed(2)}`)]);
  }

  // ---------- multi-scene (ZEN) flow ----------
  const sceneIdx = (a) => Number(/scene-(\d+)-/.exec(a.r2Key)?.[1] ?? -1);
  /** Latest asset per scene index (later rows replace earlier ones, so a regenerated scene wins). */
  async function bySceneIndex(jobId, kind, keep = () => true) {
    const m = new Map();
    for (const a of (await store.listAssets(jobId, kind)).filter(keep)) { const i = sceneIdx(a); if (i >= 0) m.set(i, a); }
    return m;
  }
  const hash = (x) => crypto.createHash('sha1').update(x).digest('hex').slice(0, 10);
  const music = createMusicFlow({ store, reply, push, gateway, storage, baseUrl, content, planProvider, owners, reasonText, approvalCard, capThb: GRADE_CAP_THB, bySceneIndex, hash });

  async function doSceneImage(job, i, prompt, quality, key) {
    const out = await gateway.run({ jobId: job.id, action: 'image', provider: 'openai', params: { prompt, quality }, idempotencyKey: key, actor: 'worker' });
    if (!out.ok || out.replay) return { out };
    const r2Key = `jobs/${job.id}/scene-${i}-${out.taskId}.jpg`;
    await storage.put(r2Key, out.result.images[0], 'image/jpeg');
    await store.addAsset({ jobId: job.id, r2Key, kind: 'image' });
    return { out, buf: out.result.images[0] };
  }

  async function sendSheet(userId, job, header, cost) {
    const scenes = job.plan.scenes;
    const have = await bySceneIndex(job.id, 'image');
    const bufs = [];
    for (let i = 0; i < scenes.length; i++) { const a = have.get(i); if (a) bufs.push(await storage.get(a.r2Key)); }
    if (!bufs.length) return push(userId, [text(header)]);
    const many = bufs.length > 6;
    const sheet = await contactSheet(bufs, many ? { cols: 4, cellW: 270, cellH: 405 } : undefined);
    const key = `jobs/${job.id}/sheet-${crypto.randomBytes(4).toString('hex')}.jpg`;
    await storage.put(key, sheet, 'image/jpeg');
    const id = await store.addAsset({ jobId: job.id, r2Key: key, kind: 'sheet' });
    const url = `${baseUrl}/img/${id}.jpg`;
    const gateB = (await store.hasApproval(job.id, 'B')) ? [] : [approvalCard(job.id, 'B', `Gate B ตรวจภาพ ${scenes.length} ซีน\n${job.plan.title}\nอนุมัติแล้วระบบทำวิดีโอต่อ`)];
    return push(userId, [{ type: 'image', originalContentUrl: url, previewImageUrl: url }, text(`${header}\nค่าใช้จ่ายภาพโดยประมาณ ฿${cost.toFixed(2)}\nอยากเปลี่ยนซีนไหน พิมพ์ ซีน <เลข> [คำบรรยายภาพใหม่]`), ...gateB]);
  }

  async function doScenes(userId, job, indices, { force = false, keyBase }) {
    const scenes = job.plan.scenes;
    const have = await bySceneIndex(job.id, 'image');
    const todo = indices.filter((i) => force || !have.has(i));
    // Many short scenes: keep image cost inside the grade cap by using the cheaper quality for G0/G1 past 8 scenes.
    const quality = scenes.length > 8 && ['G0', 'G1'].includes(job.grade) ? 'low' : (QUALITY[job.grade] ?? 'low');
    let cost = 0; const failed = []; let replays = 0;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = todo[next++];
        try {
          const prompt = job.plan.overrides?.[i] ?? scenes[i].image_prompt;
          const { out } = await doSceneImage(job, i, prompt, quality, `${keyBase}:${i}`);
          if (!out.ok) failed.push(`ซีน ${i + 1}: ${reasonText(out)}`);
          else if (out.replay) replays++;
          else cost += out.costThb;
        } catch (err) { console.error('scene_error', err?.message ?? err); failed.push(`ซีน ${i + 1}: บันทึกไฟล์ไม่สำเร็จ`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, todo.length) }, worker));
    const notes = [];
    if (replays) notes.push(`${replays} ซีนถูกทำไปแล้ว ไม่คิดเงินซ้ำ`);
    if (failed.length) notes.push(`ไม่สำเร็จ:\n${failed.join('\n')}\nพิมพ์ ซีน <เลข> เพื่อลองใหม่`);
    return sendSheet(userId, job, [`ภาพตามแผน ${scenes.length} ซีน`, ...notes].join('\n'), cost);
  }

  async function doSceneVideo(userId, job) {
    if (job.plan.music) return music.video(userId, job);   // music-led clip: the owner's song is the soundtrack, no voice-over
    const scenes = job.plan.scenes;
    const imgs = await bySceneIndex(job.id, 'image');
    if (scenes.some((_, i) => !imgs.has(i))) return push(userId, [text('ยังมีซีนที่ไม่มีภาพ พิมพ์ ซีน <เลข> เพื่อสร้างก่อน')]);
    const voiceTag = `-${job.plan.voice === 'male' ? 'male' : 'female'}-`;
    const voices = new Map([...(await bySceneIndex(job.id, 'voice', (a) => a.r2Key.includes(voiceTag)))]);   // only takes made with the chosen voice
    let cost = 0; let voiceCost = 0;
    const audioKeys = [];
    for (let i = 0; i < scenes.length; i++) {
      const old = voices.get(i);
      if (old) { audioKeys.push(old.r2Key); continue; }
      const v = await gateway.run({ jobId: job.id, action: 'voice', provider: 'elevenlabs', actor: 'worker',
        params: { text: scenes[i].text, voice: job.plan.voice, timestamps: true, previous_text: scenes[i - 1]?.text, next_text: scenes[i + 1]?.text },
        idempotencyKey: `auto-voice:${job.id}:${job.plan.voice}:${i}` });
      if (!v.ok) return push(userId, [text(`ขั้นเสียงซีน ${i + 1} ไม่สำเร็จ: ${reasonText(v)}\nพิมพ์ ทำวิดีโอ เพื่อลองใหม่`)]);
      if (v.replay) { const again = (await bySceneIndex(job.id, 'voice', (a) => a.r2Key.includes(voiceTag))).get(i); if (again) { audioKeys.push(again.r2Key); continue; } return push(userId, [text(`เสียงซีน ${i + 1} ถูกสร้างไปแล้วแต่หาไฟล์ไม่เจอ`)]); }
      const k = `jobs/${job.id}/scene-${i}${voiceTag}${v.taskId}.mp3`;
      try {
        await storage.put(k, v.result.audio, 'audio/mpeg');
        if (v.result.alignment) await storage.put(k.replace(/\.mp3$/, '.align.json'), Buffer.from(JSON.stringify(v.result.alignment)), 'application/json');
        await store.addAsset({ jobId: job.id, r2Key: k, kind: 'voice' });
      }
      catch (err) { console.error('storage_error', err?.message ?? err); return push(userId, [text('บันทึกไฟล์เสียงไม่สำเร็จ (R2)')]); }
      audioKeys.push(k); voiceCost += v.costThb;
    }
    cost += voiceCost;
    const clips = await bySceneIndex(job.id, 'clip');
    const dropped = new Set(job.plan.noClip ?? []);
    const sceneParams = scenes.map((sc, i) => ({ imageKey: imgs.get(i).r2Key, audioKey: audioKeys[i], alignKey: audioKeys[i].replace(/\.mp3$/, '.align.json'), text: sc.text, ...(clips.has(i) && !dropped.has(i) ? { clipKey: clips.get(i).r2Key } : {}) }));
    const sig = hash(sceneParams.map((x) => x.imageKey + x.audioKey + (x.clipKey ?? '')).join('|'));
    const r = await gateway.run({ jobId: job.id, action: 'render', provider: 'render', actor: 'worker',
      params: { scenes: sceneParams, title: job.plan.title }, idempotencyKey: `auto-vid:${job.id}:${sig}` });
    if (!r.ok) return push(userId, [text(`ขั้นเรนเดอร์ไม่สำเร็จ: ${reasonText(r)}\nพิมพ์ ทำวิดีโอ เพื่อลองใหม่ (เสียงที่ทำแล้วไม่คิดเงินซ้ำ)`)]);
    if (r.replay) {
      const last = await store.latestAsset(job.id, 'video');
      return push(userId, [text(last ? `วิดีโอนี้ทำไปแล้ว ไม่คิดเงินซ้ำ: ${baseUrl}/vid/${last.id}.mp4` : 'คำสั่งนี้ถูกทำไปแล้ว ไม่คิดเงินซ้ำ')]);
    }
    const videoKey = `jobs/${job.id}/${r.taskId}.mp4`;
    let vidId;
    try { await storage.put(videoKey, r.result.video, 'video/mp4'); vidId = await store.addAsset({ jobId: job.id, r2Key: videoKey, kind: 'video' }); }
    catch (err) { console.error('storage_error', err?.message ?? err); return push(userId, [text('บันทึกวิดีโอไม่สำเร็จ (R2)')]); }
    cost += r.costThb;
    return push(userId, [
      text(`วิดีโอเสร็จแล้ว (${r.result.seconds.toFixed(1)} วินาที, ${scenes.length} ซีน${sceneParams.some((x) => x.clipKey) ? `, คลิปจริง ${sceneParams.filter((x) => x.clipKey).length} ซีน` : ''}) ดูที่นี่: ${baseUrl}/vid/${vidId}.mp4\nค่าใช้จ่ายโดยประมาณ ฿${cost.toFixed(2)} (เสียง ฿${voiceCost.toFixed(2)} + เรนเดอร์ ฿${r.costThb.toFixed(2)})`),
      approvalCard(job.id, 'D', `Gate D ตรวจวิดีโอสุดท้าย\n${job.plan.title}\nอนุมัติก่อนโพสต์`),
    ]);
  }

  const planText = (plan, cost) => {
    const rows = plan.scenes.map((sc, i) => `${i + 1}. ${[...sc.text.replace(/\n/g, ' ')].slice(0, 28).join('')}…${plan.scenes.length > 8 ? '' : `\n   ภาพ: ${[...(sc.visual ?? '')].slice(0, 70).join('')}`}`).join('\n');
    const long = plan.scenes.map((sc, i) => [i + 1, [...sc.text.replace(/\s+/g, '')].length]).filter(([, n]) => n > MAX_SCENE_CHARS * 1.3).map(([i, n]) => `ซีน ${i} (~${sceneSeconds(n).toFixed(0)} วินาที)`);
    const warn = long.length ? `\n\nเตือน: ซีนเหล่านี้น่าจะค้างภาพเกิน 5 วินาที: ${long.join(', ')}\nควรเพิ่มซีนหรือแบ่งบรรทัดให้สั้นลง` : '';
    const chars = [...plan.scenes.map((sc) => sc.text).join('').replace(/\s+/g, '')].length;
    const est = estimateSeconds(chars, plan.scenes.length);
    const m = MODES[plan.mode ?? DEFAULT_MODE];
    const hook = [...plan.scenes[0].text.split('\n')[0]].slice(0, 40).join('');
    const lenNote = plan.custom || !plan.mode
      ? (est > 90 ? '\nยาวเกิน 90 วินาที ควรตัดให้สั้นลง' : est > 60 ? '\nยาวกว่า 60 วินาที ถ้าเป็นเรื่องสั้นทั่วไปควรตัดให้กระชับ' : '')
      : (est < m.secs[0] - 3 || est > m.secs[1] + 5 ? `\nความยาวต่างจากเป้าของโหมด${m.label} (${m.secs[0]}-${m.secs[1]} วินาที)` : '');
    const head = `ความยาวโดยประมาณ ${Math.round(est)} วินาที${plan.mode ? ` (โหมด${m.label} ${m.secs[0]}-${m.secs[1]} วินาที)` : ''}\nตะขอ 3 วินาทีแรก: "${hook}"${lenNote}`;
    return `แผนงาน: ${plan.title}\n${head}\n${plan.scenes.length} ซีน, ${[...plan.script].length} ตัวอักษร, เสียง${plan.voice === 'male' ? 'ชาย' : 'หญิง'}${plan.custom ? ', ภาพตามพรอมต์ของคุณ' : ', โทน ZEN'}\n\n${rows}\n\n${plan.custom ? 'ไม่มีค่าเขียนสคริปต์ (ใช้พรอมต์ของคุณ)' : `ค่าเขียนสคริปต์ประมาณ ฿${cost.toFixed(2)}`}${warn}`;
  };

  async function sceneCommand(userId, cmd, replyToken) {
    if (!gateway || !push || !storage || !contactSheet) return reply(replyToken, [text('ต้องตั้งค่า R2 ก่อน')]);
    const job = await latestA();
    if (!job?.plan?.scenes) return reply(replyToken, [text(NO_JOB)]);
    const i = cmd.n - 1;
    if (i < 0 || i >= job.plan.scenes.length) return reply(replyToken, [text(`งานนี้มี ${job.plan.scenes.length} ซีน (พิมพ์ ซีน 1 ถึง ${job.plan.scenes.length})`)]);
    if (cmd.prompt) job.plan.overrides = { ...(job.plan.overrides ?? {}), [i]: job.plan.custom ? cmd.prompt : `${cmd.prompt}. ${job.plan.style ?? STYLE_ZEN}` };
    if (cmd.prompt) await store.setPlan(job.id, job.plan);
    await reply(replyToken, [text(`กำลังสร้างซีน ${cmd.n} ใหม่ รอสักครู่`)]);
    return doScenes(userId, job, [i], { force: true, keyBase: `regen:${replyToken}` });
  }

  async function command(userId, cmd, replyToken) {
    switch (cmd.cmd) {
      case 'status': {
        const s = await store.summary();
        const lines = Object.entries(s.byState).map(([k, v]) => `${k}: ${v}`);
        return reply(replyToken, [text([`งานทั้งหมด ${s.total}`, ...lines, `ใช้วันนี้ ฿${s.spentToday.toFixed(2)} / ฿${dailyCapThb}`].join('\n'))]);
      }
      case 'jobs': {
        const list = await store.recentJobs(5);
        if (!list.length) return reply(replyToken, [text('ยังไม่มีงาน')]);
        return reply(replyToken, [text(['งานล่าสุด', ...list.map((j, i) => `${i + 1}. ${j.channelId} ${j.grade} ${j.topic.slice(0, 30)} [${j.state}]`)].join('\n'))]);
      }
      case 'sendvideo': {
        const job = await latestA();
        const v = job && await store.latestAsset(job.id, 'video');
        return reply(replyToken, [text(v ? `วิดีโอล่าสุด: ${baseUrl}/vid/${v.id}.mp4` : 'ยังไม่มีวิดีโอ')]);
      }
      case 'budget': {
        const spent = await store.spentTodayThb();
        const pct = dailyCapThb ? Math.round((spent / dailyCapThb) * 100) : 0;
        return reply(replyToken, [text(`ใช้วันนี้ ฿${spent.toFixed(2)} จากเพดาน ฿${dailyCapThb} (${pct}%)`)]);
      }
      case 'create': {
        if (notActive(cmd.channel)) return reply(replyToken, [text(notActive(cmd.channel))]);
        if (!(await store.channelExists(cmd.channel))) return reply(replyToken, [text(`ไม่พบช่อง "${cmd.channel}"`)]);
        const jobId = await store.createJob({
          channelId: cmd.channel, grade: cmd.grade, topic: cmd.topic,
          capThb: GRADE_CAP_THB[cmd.grade], requiresExpert: EXPERT_CHANNELS.has(cmd.channel),
          idempotencyKey: `job:${crypto.randomUUID()}`,
        });
        return reply(replyToken, [approvalCard(jobId, 'A', `Gate A\n${cmd.channel} ${cmd.grade}\n${cmd.topic}\nเพดาน ฿${GRADE_CAP_THB[cmd.grade]}`)]);
      }
      case 'image': {
        if (!gateway || !push || !images) return reply(replyToken, [text('การสร้างภาพยังไม่ได้ตั้งค่า')]);
        const job = await latestA();
        if (!job) return reply(replyToken, [text(NO_JOB)]);
        await reply(replyToken, [text(`กำลังสร้างภาพ (${cmd.quality}) ให้งาน: ${job.topic}\nรอสักครู่`)]);
        return doImage(userId, job, { prompt: cmd.prompt, quality: cmd.quality, key: `img:${replyToken}` });
      }
      case 'voice': {
        if (!gateway || !push || !images) return reply(replyToken, [text('การสร้างเสียงยังไม่ได้ตั้งค่า')]);
        const job = await latestA();
        if (!job) return reply(replyToken, [text(NO_JOB)]);
        await reply(replyToken, [text(`กำลังสร้างเสียง ${[...cmd.text].length} ตัวอักษร รอสักครู่`)]);
        return doVoiceOnly(userId, job, { text: cmd.text, voice: cmd.voice, key: `voice:${replyToken}` });
      }
      case 'video': {
        if (!gateway || !push || !storage) return reply(replyToken, [text('การทำวิดีโอต้องตั้งค่า R2 ก่อน')]);
        const job = await latestA();
        if (!job) return reply(replyToken, [text(NO_JOB)]);
        const pre = await videoPrecheck(job);
        if (pre) return reply(replyToken, [text(pre)]);
        await reply(replyToken, [text(`กำลังทำวิดีโอ (เสียง + ซับไทย) ให้งาน: ${job.topic}\nใช้เวลาประมาณ 1-2 นาที`)]);
        return doVideo(userId, job, { text: cmd.text, voice: cmd.voice, key: replyToken });
      }
      case 'produce':
      case 'custom': {
        if (notActive(cmd.channel)) return reply(replyToken, [text(notActive(cmd.channel))]);
        if (!gateway || !push) return reply(replyToken, [text('ระบบสร้างงานยังไม่ได้ตั้งค่า')]);
        if (!(await store.channelExists(cmd.channel))) return reply(replyToken, [text(`ไม่พบช่อง "${cmd.channel}"`)]);
        if (cmd.prompts && splitScenes(cmd.script, cmd.prompts.length, { enforce: false }).length !== cmd.prompts.length) {
          return reply(replyToken, [text(`เรื่องของคุณมีบรรทัดน้อยกว่าจำนวนซีน (${cmd.prompts.length} ซีน) แต่ละซีนต้องมีอย่างน้อย 1 บรรทัด กรุณาแบ่งเรื่องเป็นบรรทัดเพิ่ม`)]);
        }
        const jobId = await store.createJob({
          channelId: cmd.channel, grade: cmd.grade, topic: cmd.topic,
          capThb: GRADE_CAP_THB[cmd.grade], requiresExpert: EXPERT_CHANNELS.has(cmd.channel),
          idempotencyKey: `job:${crypto.randomUUID()}`,
        });
        if (cmd.prompts) {                                   // owner supplied the scene prompts: no model call, no cost
          const texts = splitScenes(cmd.script, cmd.prompts.length, { enforce: false });
          if (texts.length !== cmd.prompts.length) return reply(replyToken, [text(`เรื่องของคุณมี ${texts.length} บรรทัด แต่ใส่พรอมต์ ${cmd.prompts.length} ซีน จำนวนบรรทัดของเรื่องต้องไม่น้อยกว่าจำนวนซีน (แต่ละซีนต้องมีอย่างน้อย 1 บรรทัด)`)]);
          const plan = { title: cmd.topic, script: cmd.script, voice: cmd.voice ?? 'female', custom: true,
            scenes: texts.map((t, i) => ({ text: t, visual: cmd.prompts[i], image_prompt: cmd.prompts[i] })) };
          await store.setPlan(jobId, plan);
          const sentC = await notifyExperts({ id: jobId, channelId: cmd.channel, requiresExpert: EXPERT_CHANNELS.has(cmd.channel) }, plan);
          await reply(replyToken, [text(`รับเรื่องและพรอมต์ภาพของคุณแล้ว${sentC ? '\nส่งสคริปต์ให้ผู้เชี่ยวชาญตรวจ (Gate C) แล้ว' : ''}`)]);
          return push(userId, [
            text(planText(plan, 0)),
            approvalCard(jobId, 'A', `Gate A แผนงาน\n${cmd.channel} ${cmd.grade}\n${plan.title}\nอนุมัติแล้วระบบสร้างภาพ ${plan.scenes.length} ซีนต่อทันที`),
          ]);
        }
        await reply(replyToken, [text(cmd.script ? `รับสคริปต์ของคุณแล้ว (${[...cmd.script].length} ตัวอักษร) กำลังเตรียมภาพและเสียง: ${cmd.topic}` : `กำลังเขียนสคริปต์: ${cmd.topic}\nรอสักครู่`)]);
        const out = await gateway.run({ jobId, action: 'script', provider: planProvider, params: { channel: cmd.channel, grade: cmd.grade, topic: cmd.topic, mode: cmd.mode ?? DEFAULT_MODE, ...(cmd.script ? { script: cmd.script } : {}) }, idempotencyKey: `script:${replyToken}`, actor: 'worker' });
        if (!out.ok) return push(userId, [text(`เขียนสคริปต์ไม่สำเร็จ: ${reasonText(out)}`)]);
        if (out.replay) return push(userId, [text('คำสั่งนี้ถูกทำไปแล้ว ไม่คิดเงินซ้ำ')]);
        const plan = out.result.plan;
        await store.setPlan(jobId, plan);
        const sentC = await notifyExperts({ id: jobId, channelId: cmd.channel, requiresExpert: EXPERT_CHANNELS.has(cmd.channel) }, plan);
        if (plan.scenes) return push(userId, [
          text(planText(plan, out.costThb) + (sentC ? '\n\nส่งสคริปต์ให้ผู้เชี่ยวชาญตรวจ (Gate C) แล้ว' : '')),
          approvalCard(jobId, 'A', `Gate A แผนงาน\n${cmd.channel} ${cmd.grade}\n${plan.title}\nอนุมัติแล้วระบบสร้างภาพ ${plan.scenes.length} ซีนต่อทันที`),
        ]);
        return push(userId, [
          text(`แผนงาน: ${plan.title}\n\nสคริปต์ (${[...plan.script].length} ตัวอักษร, เสียง${plan.voice === 'male' ? 'ชาย' : 'หญิง'}):\n${plan.script}\n\nพรอมต์ภาพ:\n${plan.image_prompt}\n\nค่าเขียนสคริปต์ประมาณ ฿${out.costThb.toFixed(2)}`),
          approvalCard(jobId, 'A', `Gate A แผนงาน\n${cmd.channel} ${cmd.grade}\n${plan.title}\nอนุมัติแล้วระบบสร้างภาพต่อทันที`),
        ]);
      }
      case 'songname': return music.songName(userId, cmd, replyToken);
      case 'lyrics': return music.lyrics(userId, cmd, replyToken);
      case 'songs': return music.list(replyToken);
      case 'musicproduce': return music.produce(userId, cmd, replyToken);
      case 'clip': {
        if (!storage || !content) return reply(replyToken, [text('การรับคลิปต้องตั้งค่า R2 และ LINE ก่อน')]);
        const job = await latestA();
        if (!job?.plan?.scenes) return reply(replyToken, [text(NO_JOB)]);
        if (cmd.n < 1 || cmd.n > job.plan.scenes.length) return reply(replyToken, [text(`งานนี้มี ${job.plan.scenes.length} ซีน`)]);
        pendingClip.set(userId, { jobId: job.id, n: cmd.n, at: Date.now() });
        return reply(replyToken, [text(`ส่งคลิปแนวตั้ง (9:16) ของซีน ${cmd.n} มาได้เลยภายใน 10 นาที (ไม่เกิน 60 MB)\nเสียงในคลิปจะถูกตัดออก ใช้เสียงพากย์ของระบบแทน ถ้าคลิปสั้นกว่าซีน ระบบจะค้างภาพสุดท้ายไว้ ควรให้คลิปยาวใกล้เคียงซีน`)]);
      }
      case 'clearclip': {
        const job = await latestA();
        if (!job?.plan?.scenes) return reply(replyToken, [text(NO_JOB)]);
        job.plan.noClip = [...new Set([...(job.plan.noClip ?? []), cmd.n - 1])];
        await store.setPlan(job.id, job.plan);
        return reply(replyToken, [text(`ซีน ${cmd.n} กลับไปใช้ภาพนิ่ง (พิมพ์ ทำวิดีโอ เพื่อเรนเดอร์ใหม่)`)]);
      }
      case 'ideas':
      case 'ideasnew': {
        if (notActive(cmd.channel)) return reply(replyToken, [text(notActive(cmd.channel))]);
        if (!(await store.channelExists(cmd.channel))) return reply(replyToken, [text(`ไม่พบช่อง "${cmd.channel}"`)]);
        if (cmd.cmd === 'ideasnew') {
          if (!research) return reply(replyToken, [text('ระบบหาไอเดียยังไม่ได้ตั้งค่า')]);
          await reply(replyToken, [text(`กำลังหาไอเดียช่อง ${cmd.channel} ใช้เวลาประมาณ 1 นาที`)]);
          const r = await research(cmd.channel);
          if (!r.ok) return push(userId, [text(`หาไอเดียไม่สำเร็จ: ${reasonText({ reason: r.reason })}`)]);
        }
        const list = await store.listIdeas(cmd.channel);
        const fresh = list.filter((x) => x.status === 'new');
        if (!fresh.length) {
          const none = text(`ยังไม่มีไอเดียใหม่ของช่อง ${cmd.channel} (พิมพ์ ไอเดียใหม่ ${cmd.channel} เพื่อสั่งหาตอนนี้)`);
          return cmd.cmd === 'ideasnew' ? push(userId, [none]) : reply(replyToken, [none]);
        }
        const msgs = [text(`ไอเดียช่อง ${cmd.channel} (${list[0].runDate}) ปัดดูได้ แล้วกด "ผลิตเรื่องนี้"`), ideasCarousel(fresh)];
        return cmd.cmd === 'ideasnew' ? push(userId, msgs) : reply(replyToken, msgs);
      }
      case 'setvoice': {
        const job = await latestA();
        if (!job?.plan?.scenes) return reply(replyToken, [text(NO_JOB)]);
        job.plan.voice = cmd.voice;
        await store.setPlan(job.id, job.plan);
        return reply(replyToken, [text(`เปลี่ยนเป็นเสียง${cmd.voice === 'male' ? 'ชาย' : 'หญิง'}แล้ว พิมพ์ ทำวิดีโอ เพื่อทำเสียงและเรนเดอร์ใหม่ (ค่าเสียงใหม่คิดตามจริง ส่วนเสียงเดิมของเสียงนั้นถ้าเคยทำไว้จะไม่คิดซ้ำ)`)]);
      }
      case 'captions': {
        if (!gateway || !push) return reply(replyToken, [text('ระบบยังไม่ได้ตั้งค่า')]);
        const job = await latestA();
        if (!job?.plan?.scenes) return reply(replyToken, [text(NO_JOB)]);
        if (!(await store.approvedGates(job.id)).includes('D')) return reply(replyToken, [text('ต้องผ่าน Gate D (อนุมัติวิดีโอสุดท้าย) ก่อนสร้างชุดโพสต์')]);
        await reply(replyToken, [text('กำลังสร้างแคปชันและแฮชแท็ก 4 แพลตฟอร์ม')]);
        return doPublishPack(userId, job, { force: true, key: `caption:${job.id}:${replyToken}` });
      }
      case 'scene':
        return sceneCommand(userId, cmd, replyToken);
      case 'makevideo': {
        if (!gateway || !push || !storage) return reply(replyToken, [text('การทำวิดีโอต้องตั้งค่า R2 ก่อน')]);
        const job = await latestA();
        if (!job?.plan?.scenes) return reply(replyToken, [text(NO_JOB)]);
        if (!(await store.approvedGates(job.id)).includes('B')) return reply(replyToken, [text('ต้องผ่าน Gate B (อนุมัติภาพ) ก่อนทำวิดีโอ')]);
        if (!(await cOk(job))) return reply(replyToken, [text(WAIT_C)]);
        await reply(replyToken, [text('กำลังทำวิดีโอ (เสียง + จัดจังหวะ + ซับไทย) ใช้เวลา 2-6 นาที (ยิ่งหลายซีนยิ่งนาน)')]);
        return doSceneVideo(userId, job);
      }
      case 'pause': {
        if (cmd.target === 'all') await store.setKill('system', '*');
        else if (await store.channelExists(cmd.target)) await store.setKill('channel', cmd.target);
        else await store.setKill('provider', cmd.target);
        return reply(replyToken, [text(`พักแล้ว: ${cmd.target}`)]);
      }
      case 'resume': {
        if (cmd.target === 'all') await store.clearKill('system', '*');
        else if (await store.channelExists(cmd.target)) await store.clearKill('channel', cmd.target);
        else await store.clearKill('provider', cmd.target);
        return reply(replyToken, [text(`เริ่มต่อแล้ว: ${cmd.target}`)]);
      }
      case 'research':
        return reply(replyToken, [text('Research Inbox ยังไม่เปิดใช้งาน (ขั้นถัดไป)')]);
      default:
        return undefined;
    }
  }

  async function postback(userId, pb, replyToken) {
    const job = await store.getJob(pb.jobId);
    if (!job) return reply(replyToken, [text('ไม่พบงานนี้')]);
    const isExpert = experts.has(userId);
    if (pb.gate === 'C' && !isExpert) return reply(replyToken, [text('Gate C ต้องให้ผู้เชี่ยวชาญเป็นผู้ตัดสิน')]);
    if (pb.gate !== 'C' && isExpert) return reply(replyToken, [text('ผู้เชี่ยวชาญตัดสินได้เฉพาะ Gate C')]);
    if (await store.hasApproval(pb.jobId, pb.gate)) return reply(replyToken, [text(`Gate ${pb.gate} ตัดสินไปแล้ว`)]);
    const ok = await store.approvedGates(pb.jobId);
    if (pb.gate === 'B' && !ok.includes('A')) return reply(replyToken, [text('ต้องผ่าน Gate A ก่อน')]);
    if (pb.gate === 'D' && !(ok.includes('A') && ok.includes('B'))) return reply(replyToken, [text('ต้องผ่าน Gate A และ B ก่อน')]);
    await store.addApproval({ jobId: pb.jobId, gate: pb.gate, userId, decision: pb.decision });
    // No separate experts registered: the owner is the expert. Approving the plan at Gate A (where the full script is shown) also records Gate C.
    if (pb.gate === 'A' && pb.decision === 'approve' && job.requiresExpert && experts.size === 0) {
      await store.addApproval({ jobId: pb.jobId, gate: 'C', userId, decision: 'approve' });
    }
    await store.setJobState(pb.jobId, pb.decision === 'approve' ? `gate_${pb.gate}_ok` : pb.decision);
    if (pb.gate === 'C') {
      const label = { approve: 'อนุมัติ', revise: 'ขอให้แก้ไข', reject: 'ไม่อนุมัติ' }[pb.decision];
      await reply(replyToken, [text(`บันทึกแล้ว: ${label} ขอบคุณครับ`)]);
      await tellOwners([text(`ผู้เชี่ยวชาญ${label} Gate C: ${job.plan?.title ?? job.topic}${pb.decision === 'approve' ? '' : '\nงานนี้ยังทำเสียงและวิดีโอไม่ได้'}`)]);
      if (pb.decision === 'approve' && job.plan?.scenes && gateway && push && storage && (await store.approvedGates(job.id)).includes('B')) {
        await tellOwners([text('ผ่านครบ Gate B และ C แล้ว กำลังทำวิดีโอ ใช้เวลา 2-6 นาที (ยิ่งหลายซีนยิ่งนาน)')]);
        return doSceneVideo(owners[0], job);
      }
      return;
    }
    const next = {
      approve: pb.gate === 'B' ? 'ผ่าน Gate B แล้ว ทำวิดีโอต่อได้: วิดีโอ <ข้อความพากย์>'
        : pb.gate === 'D' ? 'ผ่าน Gate D แล้ว (การโพสต์อัตโนมัติยังไม่เปิดใช้งาน ดาวน์โหลดไฟล์ไปโพสต์เองได้)' : `Gate ${pb.gate}: อนุมัติแล้ว`,
      revise: pb.gate === 'B' ? (job.plan?.scenes ? 'รับทราบ ให้แก้: พิมพ์ ซีน <เลข> [คำบรรยายภาพใหม่] เพื่อสร้างซีนนั้นใหม่' : 'รับทราบ ให้แก้: พิมพ์ ภาพ <คำบรรยายใหม่> เพื่อสร้างใหม่')
        : pb.gate === 'D' ? 'รับทราบ ให้แก้: พิมพ์ วิดีโอ <ข้อความพากย์ใหม่> เพื่อทำใหม่' : `Gate ${pb.gate}: ขอแก้ไข`,
      reject: `Gate ${pb.gate}: ยกเลิกงานนี้`,
    }[pb.decision];
    if (pb.decision === 'approve' && pb.gate === 'D' && job.plan?.scenes && gateway && push) {
      await reply(replyToken, [text('ผ่าน Gate D แล้ว กำลังสร้างชุดโพสต์ (แคปชัน + แฮชแท็ก 4 แพลตฟอร์ม)')]);
      return doPublishPack(userId, job);
    }
    if (pb.decision === 'approve' && job.plan?.scenes && gateway && push && storage && contactSheet) {
      if (pb.gate === 'A') {
        await reply(replyToken, [text(`อนุมัติแผนแล้ว กำลังสร้างภาพ ${job.plan.scenes.length} ซีน รอสักครู่`)]);
        return doScenes(userId, job, job.plan.scenes.map((_, i) => i), { keyBase: `auto-img:${job.id}` });
      }
      if (pb.gate === 'B') {
        if (!(await cOk(job))) return reply(replyToken, [text(`ผ่าน Gate B แล้ว\n${WAIT_C}`)]);
        await reply(replyToken, [text('ผ่าน Gate B แล้ว กำลังทำวิดีโอ (เสียง + จัดจังหวะ + ซับไทย) ใช้เวลา 2-6 นาที (ยิ่งหลายซีนยิ่งนาน)')]);
        return doSceneVideo(userId, job);
      }
    }
    if (pb.decision === 'approve' && job.plan && !job.plan.scenes && gateway && push) {
      if (pb.gate === 'A') {
        await reply(replyToken, [text('อนุมัติแผนแล้ว กำลังสร้างภาพตามแผน รอสักครู่')]);
        return doImage(userId, job, { prompt: job.plan.image_prompt, quality: QUALITY[job.grade] ?? 'low', key: `auto-img:${job.id}` });
      }
      if (pb.gate === 'B' && storage) {
        const pre = await videoPrecheck(job);
        if (pre) return reply(replyToken, [text(pre)]);
        await reply(replyToken, [text('ผ่าน Gate B แล้ว กำลังทำวิดีโอ (เสียง + ซับไทย) ใช้เวลาประมาณ 1-2 นาที')]);
        return doVideo(userId, job, { text: job.plan.script, voice: job.plan.voice, key: `auto-vid:${job.id}` });
      }
    }
    return reply(replyToken, [text(next)]);
  }


  async function idea(userId, ip, replyToken) {
    const x = await store.getIdea(ip.ideaId);
    if (!x) return reply(replyToken, [text('ไม่พบไอเดียนี้')]);
    if (ip.action === 'src') {
      const src = (x.sources ?? []).map((s2, i) => `${i + 1}. ${s2.title || 'แหล่งข้อมูล'}\n${s2.url}`).join('\n');
      return reply(replyToken, [text(src ? `แหล่งที่มา: ${x.title}\n${src}` : 'ไม่มีแหล่งอ้างอิงที่ตรวจสอบได้ของไอเดียนี้ ควรตรวจข้อเท็จจริงเองก่อนผลิต')]);
    }
    if (x.status !== 'new') return reply(replyToken, [text(x.status === 'picked' ? 'เลือกไอเดียนี้ไปแล้ว' : 'ไอเดียนี้ถูกข้ามไปแล้ว')]);
    if (ip.action === 'skip') { await store.setIdeaStatus(x.id, 'skipped'); return reply(replyToken, [text('ข้ามแล้ว')]); }
    await store.setIdeaStatus(x.id, 'picked');
    return command(userId, { cmd: 'produce', channel: x.channelId, grade: 'G1', topic: `${x.title} — ${x.hook}`.slice(0, 200) }, replyToken);
  }

  /** A video message from the owner: attach it as the clip of the scene chosen with "คลิป <n>". */
  async function media(userId, msg, replyToken) {
    const want = pendingClip.get(userId);
    if (!want || Date.now() - want.at > 10 * 60 * 1000) { pendingClip.delete(userId); return reply(replyToken, [text('ถ้าจะใส่คลิปให้ซีนไหน พิมพ์ คลิป <เลขซีน> ก่อน แล้วค่อยส่งคลิป')]); }
    if (!storage || !content) return reply(replyToken, [text('การรับคลิปต้องตั้งค่า R2 และ LINE ก่อน')]);
    pendingClip.delete(userId);
    try {
      const buf = await content(msg.id);
      const key = `jobs/${want.jobId}/scene-${want.n - 1}-clip-${crypto.randomBytes(4).toString('hex')}.mp4`;
      await storage.put(key, buf, 'video/mp4');
      await store.addAsset({ jobId: want.jobId, r2Key: key, kind: 'clip' });
      const job = await store.getJob(want.jobId);
      if (job?.plan?.noClip?.includes(want.n - 1)) { job.plan.noClip = job.plan.noClip.filter((x) => x !== want.n - 1); await store.setPlan(job.id, job.plan); }
      return reply(replyToken, [text(`รับคลิปซีน ${want.n} แล้ว (${(buf.length / 1048576).toFixed(1)} MB)\nพิมพ์ ทำวิดีโอ เพื่อเรนเดอร์ใหม่ หรือส่งคลิปซีนอื่นต่อได้ด้วย คลิป <เลขซีน>`)]);
    } catch (err) {
      console.error('clip_error', err?.message ?? err);
      return reply(replyToken, [text(`รับคลิปไม่สำเร็จ: ${err?.message === 'clip_too_large' ? 'ไฟล์ใหญ่เกิน 60 MB' : 'ดาวน์โหลดจาก LINE ไม่ได้ ลองส่งใหม่'}`)]);
    }
  }

  /** Anyone may ask for their own LINE user ID (needed to register an expert). It grants nothing by itself. */
  const whoami = (userId, replyToken) => reply(replyToken, [text(`LINE user ID ของคุณ:\n${userId}\n(ส่งให้เจ้าของระบบเพื่อลงทะเบียน)`)]);

  return { command, postback, whoami, media, idea, song: music.upload };
}
