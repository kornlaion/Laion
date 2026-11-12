import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, estimateThb, GRADE_CAP_THB } from '../gateway/policy.mjs';

const base = () => ({
  req: { action: 'video', provider: 'veo', estThb: 20, idempotencyKey: 'k1', actor: 'worker' },
  job: { channelId: 'love', grade: 'G2', requiresExpert: false },
  spentJobThb: 0, spentTodayThb: 0, dailyCapThb: 1000,
  killed: {}, approvedGates: ['A', 'B'], seenKeys: new Set(),
});

test('video allowed after gates A and B', () => {
  assert.equal(decide(base()).allow, true);
});

test('video blocked until keyframe gate B is approved', () => {
  const p = base(); p.approvedGates = ['A'];
  assert.deepEqual(decide(p), { allow: false, reason: 'gate_missing_B' });
});

test('agents cannot spend money', () => {
  const p = base(); p.req.actor = 'agent:writer';
  assert.equal(decide(p).reason, 'actor_not_allowed');
});

test('job cap enforced and 80% warning raised', () => {
  const p = base(); p.spentJobThb = 100; p.req.estThb = 25; // 125 < 130, >= 104
  const r = decide(p);
  assert.equal(r.allow, true); assert.equal(r.warn, true);
  p.req.estThb = 40;                                       // 140 > 130
  assert.equal(decide(p).reason, 'job_cap_exceeded');
});

test('daily cap enforced', () => {
  const p = base(); p.spentTodayThb = 990;
  assert.equal(decide(p).reason, 'daily_cap_exceeded');
});

test('duplicate idempotency key is replayed, not paid twice', () => {
  const p = base(); p.seenKeys = new Set(['k1']);
  assert.deepEqual(decide(p), { allow: false, reason: 'duplicate', replay: true });
});

test('kill switch beats everything', () => {
  const p = base(); p.killed = { providers: ['veo'] };
  assert.equal(decide(p).reason, 'kill_switch_provider');
  p.killed = { system: true };
  assert.equal(decide(p).reason, 'kill_switch_system');
});

test('expert lane needs gate C before video', () => {
  const p = base(); p.job.requiresExpert = true;
  assert.equal(decide(p).reason, 'gate_missing_C');
  p.approvedGates = ['A', 'B', 'C'];
  assert.equal(decide(p).allow, true);
});

test('publish needs A, B and D', () => {
  const p = base(); p.req.action = 'publish'; p.approvedGates = ['A', 'B'];
  assert.equal(decide(p).reason, 'gate_missing_D');
});

test('cost estimate and grade caps', () => {
  assert.equal(estimateThb({ priceUsd: 0.05, units: 6 }), 9.9);
  assert.equal(GRADE_CAP_THB.G4, 1000);
});
