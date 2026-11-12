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
  provider_error: 'ผู้ให้บริการภาพตอบผิดพลาด',
};

export function createHandlers({ store, reply, push, gateway, images, storage, baseUrl, dailyCapThb = Number(process.env.DAILY_CAP_THB ?? 1000) }) {
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
        const job = await store.latestApprovedJob('A');
        if (!job) return reply(replyToken, [text('ยังไม่มีงานที่ผ่าน Gate A ให้พิมพ์ สร้าง <ช่อง> <เกรด> <หัวข้อ> แล้วกดอนุมัติก่อน')]);
        await reply(replyToken, [text(`กำลังสร้างภาพ (${cmd.quality}) ให้งาน: ${job.topic}\nรอสักครู่`)]);
        const out = await gateway.run({
          jobId: job.id, action: 'image', provider: 'openai',
          params: { prompt: cmd.prompt, quality: cmd.quality },
          idempotencyKey: `img:${replyToken}`, actor: 'worker',
        });
        if (!out.ok) return push(userId, [text(`สร้างภาพไม่สำเร็จ: ${REASONS[out.reason] ?? (out.reason.startsWith('gate_missing') ? 'ยังไม่ผ่านด่านอนุมัติที่จำเป็น' : out.reason)}`)]);
        if (out.replay) return push(userId, [text('คำสั่งนี้ถูกทำไปแล้ว ไม่คิดเงินซ้ำ')]);
        let name;
        if (storage) {                       // permanent copy in R2, served later by asset id
          try {
            const key = `jobs/${job.id}/${out.taskId}.jpg`;
            await storage.put(key, out.result.images[0], 'image/jpeg');
            name = await store.addAsset({ jobId: job.id, r2Key: key, kind: 'image' });
          } catch (err) { console.error('storage_error', err?.message ?? err); }
        }
        name ??= images.put(out.result.images[0]);   // fallback: temporary in-memory copy
        const url = `${baseUrl}/img/${name}.jpg`;
        const gateB = (await store.hasApproval(job.id, 'B'))
          ? []
          : [approvalCard(job.id, 'B', `Gate B ตรวจภาพ\n${job.topic}\nอนุมัติก่อนไปขั้นวิดีโอ (Veo)`)];
        return push(userId, [
          { type: 'image', originalContentUrl: url, previewImageUrl: url },
          text(`เสร็จแล้ว ค่าใช้จ่ายโดยประมาณ ฿${out.costThb.toFixed(2)}${out.warn ? ' (ใกล้เพดานงบ)' : ''}\nราคาจริงดูที่ OpenAI Usage`),
          ...gateB,
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
    if (pb.gate === 'B' && !(await store.approvedGates(pb.jobId)).includes('A')) return reply(replyToken, [text('ต้องผ่าน Gate A ก่อน')]);
    await store.addApproval({ jobId: pb.jobId, gate: pb.gate, userId, decision: pb.decision });
    await store.setJobState(pb.jobId, pb.decision === 'approve' ? `gate_${pb.gate}_ok` : pb.decision);
    const next = {
      approve: pb.gate === 'B' ? 'ผ่าน Gate B แล้ว (ขั้นวิดีโอ Veo ยังไม่เปิดใช้งาน)' : `Gate ${pb.gate}: อนุมัติแล้ว`,
      revise: pb.gate === 'B' ? 'รับทราบ ให้แก้: พิมพ์ ภาพ <คำบรรยายใหม่> เพื่อสร้างใหม่' : `Gate ${pb.gate}: ขอแก้ไข`,
      reject: `Gate ${pb.gate}: ยกเลิกงานนี้`,
    }[pb.decision];
    return reply(replyToken, [text(next)]);
  }

  return { command, postback };
}
