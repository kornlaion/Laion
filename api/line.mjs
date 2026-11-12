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
  // Owner-written script: first line = command + title, following lines = the script, used word for word.
  const custom = String(text ?? '').trim().match(/^เขียนเอง (\S+) (G[0-4])[ \t]+([^\n]{2,100})\r?\n([\s\S]{20,1200})$/);
  if (custom) return { cmd: 'custom', channel: custom[1], grade: custom[2], topic: custom[3].trim(), script: custom[4].trim() };
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
  m = t.match(/^ผลิต (\S+) (G[0-4]) (.{2,200})$/);
  if (m) return { cmd: 'produce', channel: m[1], grade: m[2], topic: m[3] };
  m = t.match(/^ซีน (\d{1,2})(?: (.{3,600}))?$/);
  if (m) return { cmd: 'scene', n: Number(m[1]), prompt: m[2] };
  if (t === 'ทำวิดีโอ') return { cmd: 'makevideo' };
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
