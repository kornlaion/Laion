import crypto from 'node:crypto';
import { GRADE_CAP_THB } from '../gateway/policy.mjs';
import { STYLE_ZEN } from '../providers/anthropic-script.mjs';

// Lane D channels (health / wellbeing) need expert Gate C before video, voice and publish.
const EXPERT_CHANNELS = new Set(['mindbody', 'healthtech']);

const text = (t) => ({ type: 'text', text: t });

/** Approval card with three postback buttons. Label max 20 chars, body max 160 (LINE limits). */
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

export function createHandlers({ store, reply, push, gateway, images, storage, baseUrl, contactSheet, dailyCapThb = Number(process.env.DAILY_CAP_THB ?? 1000) }) {
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


  // ---------- multi-scene (ZEN) flow ----------
  const sceneIdx = (a) => Number(/scene-(\d+)-/.exec(a.r2Key)?.[1] ?? -1);
  /** Latest asset per scene index (later rows replace earlier ones, so a regenerated scene wins). */
  async function bySceneIndex(jobId, kind) {
    const m = new Map();
    for (const a of await store.listAssets(jobId, kind)) { const i = sceneIdx(a); if (i >= 0) m.set(i, a); }
    return m;
  }
  const hash = (x) => crypto.createHash('sha1').update(x).digest('hex').slice(0, 10);

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
    const sheet = await contactSheet(bufs);
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
    const quality = QUALITY[job.grade] ?? 'low';
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
    const scenes = job.plan.scenes;
    const imgs = await bySceneIndex(job.id, 'image');
    if (scenes.some((_, i) => !imgs.has(i))) return push(userId, [text('ยังมีซีนที่ไม่มีภาพ พิมพ์ ซีน <เลข> เพื่อสร้างก่อน')]);
    const voices = await bySceneIndex(job.id, 'voice');
    let cost = 0; let voiceCost = 0;
    const audioKeys = [];
    for (let i = 0; i < scenes.length; i++) {
      const old = voices.get(i);
      if (old) { audioKeys.push(old.r2Key); continue; }
      const v = await gateway.run({ jobId: job.id, action: 'voice', provider: 'elevenlabs', actor: 'worker',
        params: { text: scenes[i].text, voice: job.plan.voice, previous_text: scenes[i - 1]?.text, next_text: scenes[i + 1]?.text },
        idempotencyKey: `auto-voice:${job.id}:${i}` });
      if (!v.ok) return push(userId, [text(`ขั้นเสียงซีน ${i + 1} ไม่สำเร็จ: ${reasonText(v)}\nพิมพ์ ทำวิดีโอ เพื่อลองใหม่`)]);
      if (v.replay) { const again = (await bySceneIndex(job.id, 'voice')).get(i); if (again) { audioKeys.push(again.r2Key); continue; } return push(userId, [text(`เสียงซีน ${i + 1} ถูกสร้างไปแล้วแต่หาไฟล์ไม่เจอ`)]); }
      const k = `jobs/${job.id}/scene-${i}-${v.taskId}.mp3`;
      try { await storage.put(k, v.result.audio, 'audio/mpeg'); await store.addAsset({ jobId: job.id, r2Key: k, kind: 'voice' }); }
      catch (err) { console.error('storage_error', err?.message ?? err); return push(userId, [text('บันทึกไฟล์เสียงไม่สำเร็จ (R2)')]); }
      audioKeys.push(k); voiceCost += v.costThb;
    }
    cost += voiceCost;
    const sceneParams = scenes.map((sc, i) => ({ imageKey: imgs.get(i).r2Key, audioKey: audioKeys[i], text: sc.text }));
    const sig = hash(sceneParams.map((x) => x.imageKey + x.audioKey).join('|'));
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
      text(`วิดีโอเสร็จแล้ว (${r.result.seconds.toFixed(1)} วินาที, ${scenes.length} ซีน) ดูที่นี่: ${baseUrl}/vid/${vidId}.mp4\nค่าใช้จ่ายโดยประมาณ ฿${cost.toFixed(2)} (เสียง ฿${voiceCost.toFixed(2)} + เรนเดอร์ ฿${r.costThb.toFixed(2)})`),
      approvalCard(job.id, 'D', `Gate D ตรวจวิดีโอสุดท้าย\n${job.plan.title}\nอนุมัติก่อนโพสต์`),
    ]);
  }

  const planText = (plan, cost) => {
    const rows = plan.scenes.map((sc, i) => `${i + 1}. ${[...sc.text.replace(/\n/g, ' ')].slice(0, 28).join('')}…\n   ภาพ: ${[...(sc.visual ?? '')].slice(0, 70).join('')}`).join('\n');
    return `แผนงาน: ${plan.title}\n${plan.scenes.length} ซีน, ${[...plan.script].length} ตัวอักษร, เสียง${plan.voice === 'male' ? 'ชาย' : 'หญิง'}, โทน ZEN\n\n${rows}\n\nค่าเขียนสคริปต์ประมาณ ฿${cost.toFixed(2)}`;
  };

  async function sceneCommand(userId, cmd, replyToken) {
    if (!gateway || !push || !storage || !contactSheet) return reply(replyToken, [text('ต้องตั้งค่า R2 ก่อน')]);
    const job = await latestA();
    if (!job?.plan?.scenes) return reply(replyToken, [text(NO_JOB)]);
    const i = cmd.n - 1;
    if (i < 0 || i >= job.plan.scenes.length) return reply(replyToken, [text(`งานนี้มี ${job.plan.scenes.length} ซีน (พิมพ์ ซีน 1 ถึง ${job.plan.scenes.length})`)]);
    if (cmd.prompt) job.plan.overrides = { ...(job.plan.overrides ?? {}), [i]: `${cmd.prompt}. ${STYLE_ZEN}` };
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
      case 'budget': {
        const spent = await store.spentTodayThb();
        const pct = dailyCapThb ? Math.round((spent / dailyCapThb) * 100) : 0;
        return reply(replyToken, [text(`ใช้วันนี้ ฿${spent.toFixed(2)} จากเพดาน ฿${dailyCapThb} (${pct}%)`)]);
      }
      case 'create': {
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
        if (!gateway || !push) return reply(replyToken, [text('ระบบสร้างงานยังไม่ได้ตั้งค่า')]);
        if (!(await store.channelExists(cmd.channel))) return reply(replyToken, [text(`ไม่พบช่อง "${cmd.channel}"`)]);
        const jobId = await store.createJob({
          channelId: cmd.channel, grade: cmd.grade, topic: cmd.topic,
          capThb: GRADE_CAP_THB[cmd.grade], requiresExpert: EXPERT_CHANNELS.has(cmd.channel),
          idempotencyKey: `job:${crypto.randomUUID()}`,
        });
        await reply(replyToken, [text(cmd.script ? `รับสคริปต์ของคุณแล้ว (${[...cmd.script].length} ตัวอักษร) กำลังเตรียมภาพและเสียง: ${cmd.topic}` : `กำลังเขียนสคริปต์: ${cmd.topic}\nรอสักครู่`)]);
        const out = await gateway.run({ jobId, action: 'script', provider: 'anthropic', params: { channel: cmd.channel, grade: cmd.grade, topic: cmd.topic, ...(cmd.script ? { script: cmd.script } : {}) }, idempotencyKey: `script:${replyToken}`, actor: 'worker' });
        if (!out.ok) return push(userId, [text(`เขียนสคริปต์ไม่สำเร็จ: ${reasonText(out)}`)]);
        if (out.replay) return push(userId, [text('คำสั่งนี้ถูกทำไปแล้ว ไม่คิดเงินซ้ำ')]);
        const plan = out.result.plan;
        await store.setPlan(jobId, plan);
        if (plan.scenes) return push(userId, [
          text(planText(plan, out.costThb)),
          approvalCard(jobId, 'A', `Gate A แผนงาน\n${cmd.channel} ${cmd.grade}\n${plan.title}\nอนุมัติแล้วระบบสร้างภาพ ${plan.scenes.length} ซีนต่อทันที`),
        ]);
        return push(userId, [
          text(`แผนงาน: ${plan.title}\n\nสคริปต์ (${[...plan.script].length} ตัวอักษร, เสียง${plan.voice === 'male' ? 'ชาย' : 'หญิง'}):\n${plan.script}\n\nพรอมต์ภาพ:\n${plan.image_prompt}\n\nค่าเขียนสคริปต์ประมาณ ฿${out.costThb.toFixed(2)}`),
          approvalCard(jobId, 'A', `Gate A แผนงาน\n${cmd.channel} ${cmd.grade}\n${plan.title}\nอนุมัติแล้วระบบสร้างภาพต่อทันที`),
        ]);
      }
      case 'scene':
        return sceneCommand(userId, cmd, replyToken);
      case 'makevideo': {
        if (!gateway || !push || !storage) return reply(replyToken, [text('การทำวิดีโอต้องตั้งค่า R2 ก่อน')]);
        const job = await latestA();
        if (!job?.plan?.scenes) return reply(replyToken, [text(NO_JOB)]);
        if (!(await store.approvedGates(job.id)).includes('B')) return reply(replyToken, [text('ต้องผ่าน Gate B (อนุมัติภาพ) ก่อนทำวิดีโอ')]);
        await reply(replyToken, [text('กำลังทำวิดีโอ (เสียง + จัดจังหวะ + ซับไทย) ใช้เวลาประมาณ 2-3 นาที')]);
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
    if (await store.hasApproval(pb.jobId, pb.gate)) return reply(replyToken, [text(`Gate ${pb.gate} ตัดสินไปแล้ว`)]);
    const ok = await store.approvedGates(pb.jobId);
    if (pb.gate === 'B' && !ok.includes('A')) return reply(replyToken, [text('ต้องผ่าน Gate A ก่อน')]);
    if (pb.gate === 'D' && !(ok.includes('A') && ok.includes('B'))) return reply(replyToken, [text('ต้องผ่าน Gate A และ B ก่อน')]);
    await store.addApproval({ jobId: pb.jobId, gate: pb.gate, userId, decision: pb.decision });
    await store.setJobState(pb.jobId, pb.decision === 'approve' ? `gate_${pb.gate}_ok` : pb.decision);
    const next = {
      approve: pb.gate === 'B' ? 'ผ่าน Gate B แล้ว ทำวิดีโอต่อได้: วิดีโอ <ข้อความพากย์>'
        : pb.gate === 'D' ? 'ผ่าน Gate D แล้ว (การโพสต์อัตโนมัติยังไม่เปิดใช้งาน ดาวน์โหลดไฟล์ไปโพสต์เองได้)' : `Gate ${pb.gate}: อนุมัติแล้ว`,
      revise: pb.gate === 'B' ? (job.plan?.scenes ? 'รับทราบ ให้แก้: พิมพ์ ซีน <เลข> [คำบรรยายภาพใหม่] เพื่อสร้างซีนนั้นใหม่' : 'รับทราบ ให้แก้: พิมพ์ ภาพ <คำบรรยายใหม่> เพื่อสร้างใหม่')
        : pb.gate === 'D' ? 'รับทราบ ให้แก้: พิมพ์ วิดีโอ <ข้อความพากย์ใหม่> เพื่อทำใหม่' : `Gate ${pb.gate}: ขอแก้ไข`,
      reject: `Gate ${pb.gate}: ยกเลิกงานนี้`,
    }[pb.decision];
    if (pb.decision === 'approve' && job.plan?.scenes && gateway && push && storage && contactSheet) {
      if (pb.gate === 'A') {
        await reply(replyToken, [text(`อนุมัติแผนแล้ว กำลังสร้างภาพ ${job.plan.scenes.length} ซีน รอสักครู่`)]);
        return doScenes(userId, job, job.plan.scenes.map((_, i) => i), { keyBase: `auto-img:${job.id}` });
      }
      if (pb.gate === 'B') {
        await reply(replyToken, [text('ผ่าน Gate B แล้ว กำลังทำวิดีโอ (เสียง + จัดจังหวะ + ซับไทย) ใช้เวลาประมาณ 2-3 นาที')]);
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

  return { command, postback };
}
