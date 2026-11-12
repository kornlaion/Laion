import crypto from 'node:crypto';
import { GRADE_CAP_THB } from '../gateway/policy.mjs';

/** One research run for one channel, billed through the Gateway to a small system job (G0 cap). Returns { ok, count?, reason? }. */
export async function researchChannel({ store, gateway, channelId, date, force = false }) {
  const jobId = await store.createJob({
    channelId, grade: 'G0', topic: `research ${channelId} ${date}`, capThb: GRADE_CAP_THB.G0, requiresExpert: false,
    idempotencyKey: `job:${crypto.randomUUID()}`,
  });
  await store.setJobState(jobId, 'research');
  const out = await gateway.run({
    jobId, action: 'research', provider: 'openai-research', params: { channel: channelId, date }, actor: 'worker',
    idempotencyKey: force ? `research:${channelId}:${date}:${crypto.randomUUID()}` : `research:${channelId}:${date}`,
  });
  if (!out.ok) return { ok: false, reason: out.reason === 'provider_error' ? `provider_error: ${out.message ?? ''}` : out.reason };
  if (out.replay) return { ok: true, count: 0, replay: true };           // already done today
  await store.addIdeas(channelId, date, out.result.ideas);
  return { ok: true, count: out.result.ideas.length, costThb: out.costThb };
}
