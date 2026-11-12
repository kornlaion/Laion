import http from 'node:http';
import { verifySignature, isAllowed, parseCommand, parsePostback } from './line.mjs';

const SECRET = process.env.LINE_CHANNEL_SECRET ?? '';
const ALLOW = new Set((process.env.LINE_ALLOWED_USER_IDS ?? '').split(',').filter(Boolean));
const PORT = Number(process.env.PORT ?? 8787);

// Replace with real handlers (DB + Gateway) in the next step.
const handlers = {
  async command(userId, cmd) { console.log('command', userId, cmd); },
  async postback(userId, pb) { console.log('postback', userId, pb); },
};

export function makeServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200).end('ok'); return; }
    if (req.method !== 'POST' || req.url !== '/line/webhook') { res.writeHead(404).end(); return; }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);               // raw bytes, verified before any JSON.parse

    if (!verifySignature(raw, req.headers['x-line-signature'], SECRET)) {
      res.writeHead(401).end('bad signature');
      return;
    }
    res.writeHead(200).end('ok');                    // answer LINE fast; work continues below

    const body = JSON.parse(raw.toString('utf8'));
    for (const ev of body.events ?? []) {
      const userId = ev.source?.userId;
      if (!isAllowed(userId, ALLOW)) continue;       // silently ignore strangers
      if (ev.type === 'message' && ev.message?.type === 'text') {
        const cmd = parseCommand(ev.message.text);
        if (cmd) await handlers.command(userId, cmd);
      } else if (ev.type === 'postback') {
        const pb = parsePostback(ev.postback?.data);
        if (pb) await handlers.postback(userId, pb);
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  makeServer().listen(PORT, () => console.log(`listening on ${PORT}`));
}
