import crypto from 'node:crypto';
import { GRADE_CAP_THB } from '../gateway/policy.mjs';

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

export function createHandlers({ store, reply, push, gateway, images, storage, baseUrl, dailyCapThb = Number(process.env.DAILY_CAP_THB ?? 1000) }) {
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
  const QUALITY = { G0: 'low', G1: 'low', G2: 'medium', G3: 'high', G4: 'high' };
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
      case 'produce': {
        if (!gateway || !push) return reply(replyToken, [text('ระบบสร้างงานยังไม่ได้ตั้งค่า')]);
        if (!(await store.channelExists(cmd.channel))) return reply(replyToken, [text(`ไม่พบช่อง "${cmd.channel}"`)]);
        const jobId = await store.createJob({
          channelId: cmd.channel, grade: cmd.grade, topic: cmd.topic,
          capThb: GRADE_CAP_THB[cmd.grade], requiresExpert: EXPERT_CHANNELS.has(cmd.channel),
          idempotencyKey: `job:${crypto.randomUUID()}`,
        });
        await reply(replyToken, [text(`กำลังเขียนสคริปต์: ${cmd.topic}\nรอสักครู่`)]);
        const out = await gateway.run({ jobId, action: 'script', provider: 'anthropic', params: { channel: cmd.channel, grade: cmd.grade, topic: cmd.topic }, idempotencyKey: `script:${replyToken}`, actor: 'worker' });
        if (!out.ok) return push(userId, [text(`เขียนสคริปต์ไม่สำเร็จ: ${reasonText(out)}`)]);
        if (out.replay) return push(userId, [text('คำสั่งนี้ถูกทำไปแล้ว ไม่คิดเงินซ้ำ')]);
        const plan = out.result.plan;
        await store.setPlan(jobId, plan);
        return push(userId, [
          text(`แผนงาน: ${plan.title}\n\nสคริปต์ (${[...plan.script].length} ตัวอักษร, เสียง${plan.voice === 'male' ? 'ชาย' : 'หญิง'}):\n${plan.script}\n\nพรอมต์ภาพ:\n${plan.image_prompt}\n\nค่าเขียนสคริปต์ประมาณ ฿${out.costThb.toFixed(2)}`),
          approvalCard(jobId, 'A', `Gate A แผนงาน\n${cmd.channel} ${cmd.grade}\n${plan.title}\nอนุมัติแล้วระบบสร้างภาพต่อทันที`),
        ]);
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
      revise: pb.gate === 'B' ? 'รับทราบ ให้แก้: พิมพ์ ภาพ <คำบรรยายใหม่> เพื่อสร้างใหม่'
        : pb.gate === 'D' ? 'รับทราบ ให้แก้: พิมพ์ วิดีโอ <ข้อความพากย์ใหม่> เพื่อทำใหม่' : `Gate ${pb.gate}: ขอแก้ไข`,
      reject: `Gate ${pb.gate}: ยกเลิกงานนี้`,
    }[pb.decision];
    if (pb.decision === 'approve' && job.plan && gateway && push) {
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
