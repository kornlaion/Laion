import http from 'node:http';
import { verifySignature, isAllowed, parseCommand, parsePostback } from './line.mjs';

export function makeServer({ secret, allow, handlers }) {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200).end('ok'); return; }
    if (req.method !== 'POST' || req.url !== '/line/webhook') { res.writeHead(404).end(); return; }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);               // raw bytes, verified before any JSON.parse

    if (!verifySignature(raw, req.headers['x-line-signature'], secret)) {
      res.writeHead(401).end('bad signature');
      return;
    }
    res.writeHead(200).end('ok');                    // answer LINE fast; work continues below

    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return; }
    for (const ev of body.events ?? []) {
      const userId = ev.source?.userId;
      if (!isAllowed(userId, allow)) continue;       // silently ignore strangers
      try {
        if (ev.type === 'message' && ev.message?.type === 'text') {
          const cmd = parseCommand(ev.message.text);
          if (cmd) await handlers.command(userId, cmd, ev.replyToken);
        } else if (ev.type === 'postback') {
          const pb = parsePostback(ev.postback?.data);
          if (pb) await handlers.postback(userId, pb, ev.replyToken);
        }
      } catch (err) {
        console.error('handler_error', err?.message ?? err);
      }
    }
  });
}

// Entry point: wires env -> Postgres store -> handlers -> HTTP server.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { connect, createPgStore } = await import('../gateway/store-pg.mjs');
  const { createHandlers } = await import('./app.mjs');
  const { createLineReply } = await import('./line-client.mjs');
  const secret = process.env.LINE_CHANNEL_SECRET ?? '';
  const allow = new Set((process.env.LINE_ALLOWED_USER_IDS ?? '').split(',').filter(Boolean));
  if (!secret || allow.size === 0) { console.error('Set LINE_CHANNEL_SECRET and LINE_ALLOWED_USER_IDS'); process.exit(1); }
  const store = createPgStore(await connect());
  const handlers = createHandlers({ store, reply: createLineReply() });
  const port = Number(process.env.PORT ?? 8787);
  makeServer({ secret, allow, handlers }).listen(port, () => console.log(`listening on ${port}`));
}
