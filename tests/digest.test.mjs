import test from 'node:test';
import assert from 'node:assert/strict';
import { startScheduler, buildDigest } from '../ops/digest.mjs';
import { createMemoryStore } from '../gateway/store-memory.mjs';

test('digest once per Bangkok day after the set hour; budget warning once per day; stuck jobs listed', async () => {
  const store = createMemoryStore({ rates: [] });
  await store.createJob({ channelId: 'love', grade: 'G1', topic: 'เรื่องเก่า', createdAt: new Date(Date.now() - 30 * 3600_000) });
  store.state.ledger.push({ costThb: 900, at: new Date() });
  const sent = [];
  let t = new Date('2026-11-12T13:00:00Z');                 // 20:00 Bangkok
  const s = startScheduler({ store, push: async (id, m) => sent.push([id, m[0].text]), owners: ['U1'], dailyCapThb: 1000, digestHour: 21, now: () => t, tickMs: 3600_000 });
  store.spentTodayThb = async () => 900;
  await s.tick();
  assert.equal(sent.length, 1);                              // budget warning only (20:00 is before 21:00)
  assert.match(sent[0][1], /เตือนงบ.*90%/);
  t = new Date('2026-11-12T14:05:00Z');                      // 21:05 Bangkok
  await s.tick(); await s.tick();
  assert.equal(sent.length, 2);                              // digest once, no second warning
  assert.match(sent[1][1], /สรุปประจำวัน/);
  assert.match(sent[1][1], /งานค้างเกิน 24 ชม. 1/);
  t = new Date('2026-11-13T14:05:00Z');                      // next day
  await s.tick();
  assert.equal(sent.length, 4);                              // warning + digest again
  s.stop();
});
