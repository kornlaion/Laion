// In-memory store: same interface as store-pg.mjs. Used by tests and local dry runs.
export function createMemoryStore({ jobs = [], rates = [], approvals = [], killed = {} } = {}) {
  const state = { tasks: [], ledger: [], auditLog: [], approvals: [...approvals], killed, nextId: 1 };
  return {
    state,
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
