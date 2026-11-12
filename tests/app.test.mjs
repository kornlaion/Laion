import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHandlers } from '../api/app.mjs';
import { makeServer } from '../api/server.mjs';
import { createMemoryStore } from '../gateway/store-memory.mjs';
import { parseCommand, parsePostback } from '../api/line.mjs';

function setup() {
  const store = createMemoryStore();
  const sent = [];
  const reply = async (token, messages) => { sent.push({ token, messages }); };
  const h = createHandlers({ store, reply, dailyCapThb: 1000 });
  const last = () => sent.at(-1).messages[0];
  return { store, h, sent, last };
}

test('create opens a job and sends a Gate A card; approving records it once', async () => {
  const { store, h, last } = setup();
  await h.command('U1', parseCommand('สร้าง love G1 เพลงรักแรกพบ'), 'rt1');
  assert.equal(store.jobs.length, 1);
  assert.equal(store.jobs[0].capThb, 35);
  assert.equal(store.jobs[0].requiresExpert, false);
  const data = last().template.actions[0].data;
  const pb = parsePostback(data);
  assert.equal(pb.gate, 'A');

  await h.postback('U1', pb, 'rt2');
  assert.deepEqual(await store.approvedGates(pb.jobId), ['A']);
  assert.equal(store.jobs[0].state, 'gate_A_ok');

  await h.postback('U1', pb, 'rt3');                       // second tap is ignored
  assert.equal(store.state.approvals.length, 1);
  assert.match(last().text, /ตัดสินไปแล้ว/);
});

test('health channels require expert gate C', async () => {
  const { store, h } = setup();
  await h.command('U1', parseCommand('สร้าง healthtech G2 นอนหลับ'), 'rt');
  assert.equal(store.jobs[0].requiresExpert, true);
});

test('unknown channel is refused', async () => {
  const { store, h, last } = setup();
  await h.command('U1', parseCommand('สร้าง nope G1 x'), 'rt');
  assert.equal(store.jobs.length, 0);
  assert.match(last().text, /ไม่พบช่อง/);
});

test('pause and resume toggle the kill switch', async () => {
  const { store, h } = setup();
  await h.command('U1', parseCommand('พัก all'), 'rt');
  assert.equal((await store.killed()).system, true);
  await h.command('U1', parseCommand('เริ่ม all'), 'rt');
  assert.equal((await store.killed()).system, false);
  await h.command('U1', parseCommand('พัก love'), 'rt');
  assert.deepEqual((await store.killed()).channels, ['love']);
  await h.command('U1', parseCommand('พัก veo'), 'rt');
  assert.deepEqual((await store.killed()).providers, ['veo']);
});

test('status and budget reply', async () => {
  const { h, last } = setup();
  await h.command('U1', { cmd: 'status' }, 'rt');
  assert.match(last().text, /งานทั้งหมด 0/);
  await h.command('U1', { cmd: 'budget' }, 'rt');
  assert.match(last().text, /0%/);
});

test('http server: bad signature 401, strangers ignored, owner command handled', async () => {
  const calls = [];
  let done; const handled = new Promise((r) => { done = r; });
  const handlers = { command: async (u, c) => { calls.push([u, c]); done(); }, postback: async () => {} };
  const secret = 's3cret';
  const server = makeServer({ secret, allow: new Set(['Uowner']), handlers });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/line/webhook`;
  const body = JSON.stringify({ events: [
    { type: 'message', message: { type: 'text', text: 'สถานะ' }, source: { userId: 'Ustranger' }, replyToken: 'a' },
    { type: 'message', message: { type: 'text', text: 'สถานะ' }, source: { userId: 'Uowner' }, replyToken: 'b' },
  ] });
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64');

  const bad = await fetch(url, { method: 'POST', body, headers: { 'x-line-signature': 'nope' } });
  assert.equal(bad.status, 401);
  const ok = await fetch(url, { method: 'POST', body, headers: { 'x-line-signature': sig } });
  assert.equal(ok.status, 200);
  await handled;
  assert.deepEqual(calls, [['Uowner', { cmd: 'status' }]]);
  server.close();
});
