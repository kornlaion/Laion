import crypto from 'node:crypto';

/** LINE signs the RAW body (HMAC-SHA256, base64) in x-line-signature. Never parse before verifying. */
export function verifySignature(rawBody, signatureHeader, channelSecret) {
  if (!signatureHeader || !channelSecret) return false;
  const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest();
  let given;
  try {
    given = Buffer.from(signatureHeader, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function isAllowed(userId, allowlist) {
  return typeof userId === 'string' && allowlist.has(userId);
}

/** Thai command grammar from the doc. Returns null for anything unrecognised. */
export function parseCommand(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (t === 'สถานะ') return { cmd: 'status' };
  if (t === 'งบ') return { cmd: 'budget' };
  let m = t.match(/^สร้าง (\S+) (G[0-4]) (.+)$/);
  if (m) return { cmd: 'create', channel: m[1], grade: m[2], topic: m[3] };
  m = t.match(/^ภาพ (?:(low|medium|high) )?(.{3,800})$/);
  if (m) return { cmd: 'image', quality: m[1] ?? 'low', prompt: m[2] };
  m = t.match(/^เสียง (?:(ชาย|หญิง) )?(.{2,400})$/);
  if (m) return { cmd: 'voice', voice: m[1] === 'ชาย' ? 'male' : m[1] === 'หญิง' ? 'female' : undefined, text: m[2] };
  m = t.match(/^วิดีโอ (?:(ชาย|หญิง) )?(.{2,400})$/);
  if (m) return { cmd: 'video', voice: m[1] === 'ชาย' ? 'male' : m[1] === 'หญิง' ? 'female' : undefined, text: m[2] };
  m = t.match(/^พัก (\S+)$/);
  if (m) return { cmd: 'pause', target: m[1] };
  m = t.match(/^เริ่ม (\S+)$/);
  if (m) return { cmd: 'resume', target: m[1] };
  m = t.match(/^วิจัย (https?:\/\/\S+)$/);
  if (m) return { cmd: 'research', url: m[1] };
  return null;
}

/** Postback data for approval buttons: `gate:<jobId>:<A|B|C|D>:<approve|revise|reject>:<nonce>` */
export function parsePostback(data) {
  const m = String(data ?? '').match(/^gate:([0-9a-f-]{36}):([ABCD]):(approve|revise|reject):([A-Za-z0-9]{8,})$/);
  return m ? { jobId: m[1], gate: m[2], decision: m[3], nonce: m[4] } : null;
}
