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
    if (!res.ok) console.error('line_reply_failed', res.status);
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
    if (!res.ok) console.error('line_push_failed', res.status);
  };
}
