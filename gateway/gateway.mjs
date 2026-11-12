import crypto from 'node:crypto';
import { decide, estimateThb } from './policy.mjs';

/**
 * The ONLY code path allowed to call a provider.
 * store:    see gateway/store-memory.mjs for the interface (Postgres impl in store-pg.mjs)
 * adapters: { [provider]: { model(params), unit, units(params), call(params) } }
 */
export function createGateway({ store, adapters, usdThb = 33, dailyCapThb = Number(process.env.DAILY_CAP_THB ?? 1000) }) {
  async function run({ jobId, action, provider, params = {}, idempotencyKey, actor }) {
    const adapter = adapters[provider];
    const hash = crypto.createHash('sha256').update(JSON.stringify({ jobId, action, provider, params })).digest('hex');
    const audit = (what) => store.audit({ actor, action: `${what}:${action}:${provider}`, payloadHash: hash });

    if (!adapter) { await audit('deny:no_adapter'); return { ok: false, reason: 'no_adapter' }; }

    const job = await store.getJob(jobId);
    if (!job) { await audit('deny:no_job'); return { ok: false, reason: 'no_job' }; }

    const rate = await store.getRate(provider, adapter.model(params), adapter.unit);
    if (rate == null) { await audit('deny:no_rate'); return { ok: false, reason: 'no_rate' }; }

    const units = adapter.units(params);
    const estThb = estimateThb({ priceUsd: rate, units, usdThb });
    const existing = await store.findTaskByKey(idempotencyKey);

    const decision = decide({
      req: { action, provider, estThb, idempotencyKey, actor },
      job,
      spentJobThb: await store.spentJobThb(jobId),
      spentTodayThb: await store.spentTodayThb(),
      dailyCapThb,
      killed: await store.killed(),
      approvedGates: await store.approvedGates(jobId),
      seenKeys: new Set(existing ? [idempotencyKey] : []),
    });

    if (!decision.allow) {
      await audit(`deny:${decision.reason}`);
      return decision.replay ? { ok: true, replay: true, task: existing } : { ok: false, reason: decision.reason };
    }

    const taskId = await store.createTask({ jobId, provider, action, idempotencyKey });
    if (!taskId) { await audit('deny:duplicate'); return { ok: true, replay: true, task: await store.findTaskByKey(idempotencyKey) }; }

    try {
      const result = await adapter.call(params);
      await store.addLedger({ taskId, provider, units, costUsd: rate * units, costThb: estThb });
      await store.finishTask(taskId, 'done', result.externalId ?? null);
      await audit('ok');
      return { ok: true, taskId, warn: decision.warn, result, costThb: estThb };
    } catch (err) {
      // A failed call is not billed here; the provider-side limit is the backstop.
      await store.finishTask(taskId, 'failed', null);
      await audit('error');
      return { ok: false, reason: 'provider_error', message: String(err?.message ?? err) };
    }
  }
  return { run };
}
