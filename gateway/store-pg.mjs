// PostgreSQL store (Supabase). NOT yet tested against a live database.
// Needs the `pg` package (declared in package.json; installed by the host at deploy).
const BKK_TODAY = "(now() at time zone 'Asia/Bangkok')::date";

export function createPgStore(pool) {
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0] ?? null;
  return {
    getJob: (id) => one(
      `select id, channel_id as "channelId", grade, topic, plan, requires_expert as "requiresExpert", cap_thb as "capThb"
         from jobs where id = $1`, [id]),

    setPlan: (id, plan) => pool.query(`update jobs set plan = $2::jsonb where id = $1`, [id, JSON.stringify(plan)]),

    latestApprovedJob: (gate) => one(
      `select j.id, j.channel_id as "channelId", j.grade, j.topic, j.requires_expert as "requiresExpert", j.cap_thb as "capThb"
         from jobs j join approvals a on a.job_id = j.id
        where a.gate = $1 and a.decision = 'approve'
        order by j.created_at desc limit 1`, [gate]),

    async addAsset({ jobId, r2Key, kind }) {
      const r = await one(`insert into assets (job_id, r2_key, kind) values ($1, $2, $3) returning id`, [jobId, r2Key, kind]);
      return r.id;
    },
    latestAsset: (jobId, kind) => one(
      `select id, job_id as "jobId", r2_key as "r2Key", kind from assets where job_id = $1 and kind = $2 order by created_at desc limit 1`, [jobId, kind]),
    getAsset: (id) => one(`select id, job_id as "jobId", r2_key as "r2Key", kind from assets where id = $1`, [id]),

    async getRate(provider, model, unit) {
      const r = await one(
        `select price_usd from provider_rates
          where provider = $1 and model = $2 and unit = $3 and valid_from <= current_date
          order by valid_from desc limit 1`, [provider, model, unit]);
      return r ? Number(r.price_usd) : null;
    },

    async approvedGates(jobId) {
      const { rows } = await pool.query(
        `select distinct gate from approvals where job_id = $1 and decision = 'approve'`, [jobId]);
      return rows.map((r) => r.gate);
    },

    async spentJobThb(jobId) {
      const r = await one(
        `select coalesce(sum(l.cost_thb), 0) as s from ledger l
           join tasks t on t.id = l.task_id where t.job_id = $1`, [jobId]);
      return Number(r.s);
    },

    async spentTodayThb() {
      const r = await one(
        `select coalesce(sum(cost_thb), 0) as s from ledger
          where (at at time zone 'Asia/Bangkok')::date = ${BKK_TODAY}`, []);
      return Number(r.s);
    },

    async channelExists(id) { return Boolean(await one(`select 1 from channels where id = $1`, [id])); },

    async createJob({ channelId, grade, topic, capThb, requiresExpert, idempotencyKey }) {
      const r = await one(
        `insert into jobs (channel_id, grade, topic, cap_thb, requires_expert, idempotency_key)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [channelId, grade, topic, capThb, requiresExpert, idempotencyKey]);
      return r.id;
    },

    setJobState: (id, state) => pool.query(`update jobs set state = $2 where id = $1`, [id, state]),

    async hasApproval(jobId, gate) {
      return Boolean(await one(`select 1 from approvals where job_id = $1 and gate = $2 and decision <> 'revise'`, [jobId, gate]));
    },

    addApproval: ({ jobId, gate, userId, decision }) =>
      pool.query(`insert into approvals (job_id, gate, user_id, decision) values ($1, $2, $3, $4)`, [jobId, gate, userId, decision]),

    setKill: (scope, key) =>
      pool.query(`insert into kill_switch (scope, key) values ($1, $2) on conflict do nothing`, [scope, key]),

    clearKill: (scope, key) => pool.query(`delete from kill_switch where scope = $1 and key = $2`, [scope, key]),

    async summary() {
      const { rows } = await pool.query(`select state, count(*)::int as n from jobs group by state`);
      const byState = Object.fromEntries(rows.map((r) => [r.state, r.n]));
      const total = rows.reduce((s, r) => s + r.n, 0);
      const t = await one(
        `select coalesce(sum(cost_thb), 0) as s from ledger where (at at time zone 'Asia/Bangkok')::date = ${BKK_TODAY}`, []);
      return { total, byState, spentToday: Number(t.s) };
    },

    async killed() {
      const { rows } = await pool.query(`select scope, key from kill_switch`);
      return {
        system: rows.some((r) => r.scope === 'system'),
        channels: rows.filter((r) => r.scope === 'channel').map((r) => r.key),
        providers: rows.filter((r) => r.scope === 'provider').map((r) => r.key),
      };
    },

    findTaskByKey: (key) => one(
      `select id, status, external_op_id as "externalOpId", idempotency_key as "idempotencyKey"
         from tasks where idempotency_key = $1`, [key]),

    async createTask({ jobId, provider, action, idempotencyKey }) {
      const r = await one(
        `insert into tasks (job_id, provider, action, status, idempotency_key)
         values ($1, $2, $3, 'running', $4)
         on conflict (idempotency_key) do nothing returning id`, [jobId, provider, action, idempotencyKey]);
      return r?.id ?? null;
    },

    finishTask: (id, status, externalOpId) =>
      pool.query(`update tasks set status = $2, external_op_id = $3 where id = $1`, [id, status, externalOpId]),

    addLedger: ({ taskId, provider, units, costUsd, costThb }) =>
      pool.query(
        `insert into ledger (task_id, provider, units, cost_usd, cost_thb) values ($1, $2, $3, $4, $5)`,
        [taskId, provider, units, costUsd, costThb]),

    audit: ({ actor, action, payloadHash }) =>
      pool.query(`insert into audit_log (actor, action, payload_hash) values ($1, $2, $3)`, [actor, action, payloadHash]),
  };
}

export async function connect(databaseUrl = process.env.DATABASE_URL) {
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: databaseUrl, max: 5, ssl: { rejectUnauthorized: false } });
}
