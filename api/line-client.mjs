/** LINE's own error text (which message/field it rejected). Never contains the token. */
async function errorDetail(res) {
  try { return JSON.stringify(await res.json()).slice(0, 300); } catch { return ''; }
}

// LINE Reply API client. Reply tokens are short-lived and single use.
export function createLineReply({ token = process.env.LINE_CHANNEL_ACCESS_TOKEN, fetchImpl = fetch } = {}) {
  return async function reply(replyToken, messages) {
    if (!replyToken) return;
    if (!token) { console.error('LINE_CHANNEL_ACCESS_TOKEN missing'); return; }
    const res = await fetchImpl('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ replyToken, messages }),
    });
    if (!res.ok) console.error('line_reply_failed', res.status, await errorDetail(res));
  };
}

/** Push API: used when work outlives the reply token (e.g. image generation). Counts toward the LINE message quota. */
export function createLinePush({ token = process.env.LINE_CHANNEL_ACCESS_TOKEN, fetchImpl = fetch } = {}) {
  return async function push(userId, messages) {
    if (!token) { console.error('LINE_CHANNEL_ACCESS_TOKEN missing'); return; }
    const res = await fetchImpl('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: userId, messages }),
    });
    if (!res.ok) console.error('line_push_failed', res.status, await errorDetail(res));
  };
}

/** Downloads the bytes of an image/video/audio message the user sent to the bot (LINE keeps them only for a limited time). */
export function createLineContent({ token = process.env.LINE_CHANNEL_ACCESS_TOKEN, fetchImpl = fetch, maxBytes = 60 * 1024 * 1024 } = {}) {
  return async function content(messageId) {
    if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN missing');
    const res = await fetchImpl(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`line_content_${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('clip_too_large');
    return buf;
  };
}
