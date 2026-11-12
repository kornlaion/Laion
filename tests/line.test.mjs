import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySignature, isAllowed, parseCommand, parsePostback } from '../api/line.mjs';

const secret = 'test-secret';
const body = Buffer.from('{"events":[{"type":"message"}]}');
const sign = (b, s = secret) => crypto.createHmac('sha256', s).update(b).digest('base64');

test('valid signature passes, tampered body or wrong secret fails', () => {
  assert.equal(verifySignature(body, sign(body), secret), true);
  assert.equal(verifySignature(Buffer.from(body + ' '), sign(body), secret), false);
  assert.equal(verifySignature(body, sign(body, 'other'), secret), false);
  assert.equal(verifySignature(body, undefined, secret), false);
  assert.equal(verifySignature(body, sign(body), ''), false);
});

test('allowlist', () => {
  const allow = new Set(['U1']);
  assert.equal(isAllowed('U1', allow), true);
  assert.equal(isAllowed('U2', allow), false);
  assert.equal(isAllowed(undefined, allow), false);
});

test('Thai commands', () => {
  assert.deepEqual(parseCommand('สถานะ'), { cmd: 'status' });
  assert.deepEqual(parseCommand(' งบ '), { cmd: 'budget' });
  assert.deepEqual(parseCommand('สร้าง love G1 เพลงรักแรกพบ'), { cmd: 'create', channel: 'love', grade: 'G1', topic: 'เพลงรักแรกพบ' });
  assert.deepEqual(parseCommand('พัก all'), { cmd: 'pause', target: 'all' });
  assert.deepEqual(parseCommand('วิจัย https://example.com/a'), { cmd: 'research', url: 'https://example.com/a' });
  assert.equal(parseCommand('สร้าง love G9 x'), null);
  assert.equal(parseCommand('hello'), null);
});

test('postback format', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  assert.deepEqual(parsePostback(`gate:${id}:B:approve:abcd1234`), { jobId: id, gate: 'B', decision: 'approve', nonce: 'abcd1234' });
  assert.equal(parsePostback('gate:bad:B:approve:abcd1234'), null);
});
