import crypto from 'node:crypto';
// In-memory store: same interface as store-pg.mjs. Used by tests and local dry runs.
export function createMemoryStore({ jobs = [], rates = [], approvals = [], killed = {}, channels = ['love', 'mindbody', 'energy-ai', 'healthtech', 'pet'] } = {}) {
  const state = { tasks: [], ledger: [], auditLog: [], approvals: [...approvals], killed: { ...killed }, nextId: 1 };
  return {
    state,
    jobs,
    async channelExists(id) { return channels.includes(id); },
    async createJob(j) {
      const id = crypto.randomUUID();   // same shape as Postgres uuid
      jobs.push({ id, state: 'planned', ...j });
      return id;
    },
    async setPlan(id, plan) { jobs.find((j) => j.id === id).plan = plan; },
    async setJobState(id, s) { jobs.find((j) => j.id === id).state = s; },
    async hasApproval(jobId, gate) { return state.approvals.some((a) => a.jobId === jobId && a.gate === gate && a.decision !== 'revise'); },
    async addApproval(a) { state.approvals.push(a); },
    async setKill(scope, key) {
      const k = state.killed;
      if (scope === 'system') k.system = true;
      else { const f = scope === 'channel' ? 'channels' : 'providers'; k[f] = [...new Set([...(k[f] ?? []), key])]; }
    },
    async clearKill(scope, key) {
      const k = state.killed;
      if (scope === 'system') k.system = false;
      else { const f = scope === 'channel' ? 'channels' : 'providers'; k[f] = (k[f] ?? []).filter((x) => x !== key); }
    },
    async summary() {
      const byState = {};
      for (const j of jobs) byState[j.state ?? 'planned'] = (byState[j.state ?? 'planned'] ?? 0) + 1;
      return { total: jobs.length, byState, spentToday: state.ledger.reduce((s, l) => s + l.costThb, 0) };
    },
    async latestApprovedJob(gate) {
      const ids = state.approvals.filter((a) => a.gate === gate && a.decision === 'approve').map((a) => a.jobId);
      for (let i = jobs.length - 1; i >= 0; i--) if (ids.includes(jobs[i].id)) return jobs[i];
      return null;
    },
    async addAsset({ jobId, r2Key, kind }) {
      const id = crypto.randomUUID(); (state.assets ??= []).push({ id, jobId, r2Key, kind }); return id;
    },
    async listAssets(jobId, kind) { return (state.assets ?? []).filter((a) => a.jobId === jobId && a.kind === kind); },
    async latestAsset(jobId, kind) {
      const l = (state.assets ?? []).filter((a) => a.jobId === jobId && a.kind === kind); return l.at(-1) ?? null;
    },
    async getAsset(id) { return (state.assets ?? []).find((a) => a.id === id) ?? null; },
    async recentJobs(n = 5) { return jobs.slice(-n).reverse().map((j) => ({ id: j.id, channelId: j.channelId, grade: j.grade, topic: j.topic, state: j.state })); },
    async getJob(id) { return jobs.find((j) => j.id === id) ?? null; },
    async getRate(provider, model, unit) {
      const r = rates.find((x) => x.provider === provider && x.model === model && x.unit === unit);
      return r ? r.priceUsd : null;
    },
    async approvedGates(jobId) {
      return [...new Set(state.approvals.filter((a) => a.jobId === jobId && a.decision === 'approve').map((a) => a.gate))];
    },
    async spentJobThb(jobId) {
      const ids = new Set(state.tasks.filter((t) => t.jobId === jobId).map((t) => t.id));
      return state.ledger.filter((l) => ids.has(l.taskId)).reduce((s, l) => s + l.costThb, 0);
    },
    async spentTodayThb() { return state.ledger.reduce((s, l) => s + l.costThb, 0); },
    async killed() { return state.killed; },
    async findTaskByKey(key) { return state.tasks.find((t) => t.idempotencyKey === key) ?? null; },
    async createTask(t) {
      if (state.tasks.some((x) => x.idempotencyKey === t.idempotencyKey)) return null;
      const id = `task-${state.nextId++}`;
      state.tasks.push({ id, status: 'running', ...t });
      return id;
    },
    async finishTask(id, status, externalOpId) {
      Object.assign(state.tasks.find((t) => t.id === id), { status, externalOpId });
    },
    async addLedger(l) { state.ledger.push(l); },
    async audit(a) { state.auditLog.push(a); },
  };
}
