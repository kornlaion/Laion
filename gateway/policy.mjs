// Tool Gateway policy: plain code, no model judgement.
// Every provider call must pass decide() before money is spent.

export const GRADE_CAP_THB = { G0: 10, G1: 35, G2: 130, G3: 320, G4: 1000 };
export const WARN_RATIO = 0.8;

// Which gates must be approved before each action.
const REQUIRED_GATES = {
  caption: ['A', 'B', 'D'],   // publish pack (captions/hashtags), only after the final video is approved
  align: [],           // timing the owner's own lyrics against the singing (cheap, before Gate A)
  research: [],        // daily topic research, billed to a per-channel system job
  script: [],          // a cheap draft shown to the owner BEFORE Gate A, so Gate A approves a real plan
  image: ['A'],
  voice: ['A'],
  video: ['A', 'B'],   // Veo is paid only after the keyframe is approved
  render: ['A', 'B'],
  publish: ['A', 'B', 'D'],
};
const PAID_ACTIONS = new Set(['research', 'align', 'caption', 'script', 'image', 'voice', 'video', 'render']);

/**
 * @param {object} p
 * @param {{action:string, provider:string, estThb:number, idempotencyKey:string, actor:string}} p.req
 * @param {{channelId:string, grade:string, requiresExpert:boolean, capThb?:number}} p.job
 * @param {number} p.spentJobThb      from ledger
 * @param {number} p.spentTodayThb    from ledger (all channels)
 * @param {number} p.dailyCapThb
 * @param {{system?:boolean, channels?:string[], providers?:string[]}} p.killed
 * @param {string[]} p.approvedGates  gates approved for this job
 * @param {Set<string>} p.seenKeys    idempotency keys already executed
 */
export function decide({ req, job, spentJobThb, spentTodayThb, dailyCapThb, killed = {}, approvedGates = [], seenKeys = new Set() }) {
  if (killed.system) return deny('kill_switch_system');
  if (killed.channels?.includes(job.channelId)) return deny('kill_switch_channel');
  if (killed.providers?.includes(req.provider)) return deny('kill_switch_provider');

  // Agents never call providers; only the worker identity may.
  if (PAID_ACTIONS.has(req.action) && req.actor !== 'worker') return deny('actor_not_allowed');

  if (seenKeys.has(req.idempotencyKey)) return { allow: false, reason: 'duplicate', replay: true };

  const gates = REQUIRED_GATES[req.action];
  if (!gates) return deny('unknown_action');
  const need = job.requiresExpert && !['image', 'script', 'research', 'align'].includes(req.action) ? [...gates, 'C'] : gates;
  const missing = need.filter((g) => !approvedGates.includes(g));
  if (missing.length) return deny(`gate_missing_${missing.join('')}`);

  if (PAID_ACTIONS.has(req.action)) {
    const cap = job.capThb ?? GRADE_CAP_THB[job.grade];
    if (spentJobThb + req.estThb > cap) return deny('job_cap_exceeded');
    if (spentTodayThb + req.estThb > dailyCapThb) return deny('daily_cap_exceeded');
    const warn = spentJobThb + req.estThb >= cap * WARN_RATIO;
    return { allow: true, reason: 'ok', warn };
  }
  return { allow: true, reason: 'ok', warn: false };
}

function deny(reason) {
  return { allow: false, reason };
}

/** Cost from provider_rates row (usd per unit) -> THB. */
export function estimateThb({ priceUsd, units, usdThb = 33 }) {
  return Math.round(priceUsd * units * usdThb * 100) / 100;
}
