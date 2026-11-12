import http from 'node:http';
import { verifySignature, isAllowed, parseCommand, parsePostback, parseIdeaPostback } from './line.mjs';

export function makeServer({ secret, allow, handlers, images, assets, experts = new Set() }) {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200).end('ok'); return; }
    const img = req.method === 'GET' && images && req.url.match(/^\/(?:img|aud|vid)\/([0-9a-f]{48}|[0-9a-f-]{36})\.(jpg|mp3|mp4)$/);
    if (img) {
      let buf = img[1].length === 48 ? images.get(img[1]) : null;
      if (img[1].length === 36 && assets) { try { buf = await assets(img[1]); } catch (e) { console.error('asset_error', e?.message ?? e); } }
      if (!buf) { res.writeHead(404).end(); return; }
      const type = { mp3: 'audio/mpeg', mp4: 'video/mp4', jpg: 'image/jpeg' }[img[2]];
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');   // Safari and LINE need byte ranges for video
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, buf.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
        if (start > end || start >= buf.length) { res.writeHead(416, { 'content-range': `bytes */${buf.length}` }).end(); return; }
        res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': end - start + 1 }).end(buf.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': buf.length, 'cache-control': 'private, max-age=3600' }).end(buf);
      return;
    }
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
      console.log('event', ev.type, 'from', userId ? `${userId.slice(0, 5)}…(${userId.length})` : 'unknown');
      if (ev.type === 'message' && ev.message?.type === 'text' && parseCommand(ev.message.text)?.cmd === 'whoami' && handlers.whoami && userId) {
        try { await handlers.whoami(userId, ev.replyToken); } catch (err) { console.error('handler_error', err?.message ?? err); }
        continue;
      }
      const expertPostback = ev.type === 'postback' && experts.has(userId);   // experts may only press Gate C buttons
      if (!isAllowed(userId, allow) && !expertPostback) {                // ignore strangers, but say so in our own logs
        console.log('ignored: user not in LINE_ALLOWED_USER_IDS');
        continue;
      }
      try {
        if (ev.type === 'message' && ev.message?.type === 'text') {
          const cmd = parseCommand(ev.message.text);
          if (cmd) { console.log('command', cmd.cmd); await handlers.command(userId, cmd, ev.replyToken); }
          else console.log('ignored: text is not a known command');
        } else if (ev.type === 'message' && ev.message?.type === 'video' && handlers.media) {
          await handlers.media(userId, ev.message, ev.replyToken);
        } else if (ev.type === 'postback') {
          const pb = parsePostback(ev.postback?.data);
          const ip = pb ? null : parseIdeaPostback(ev.postback?.data);
          if (pb) await handlers.postback(userId, pb, ev.replyToken);
          else if (ip && handlers.idea && isAllowed(userId, allow)) await handlers.idea(userId, ip, ev.replyToken);
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
  const { contactSheet } = await import('../render/zen.mjs');
  const { createLineReply, createLinePush, createLineContent } = await import('./line-client.mjs');
  const { createImageCache } = await import('./images.mjs');
  const { createGateway } = await import('../gateway/gateway.mjs');
  const { createOpenAIImageAdapter } = await import('../providers/openai-image.mjs');
  const { createElevenLabsAdapter } = await import('../providers/elevenlabs.mjs');
  const { createRenderAdapter } = await import('../providers/render.mjs');
  const { createScriptAdapter } = await import('../providers/anthropic-script.mjs');
  const { createResearchAdapter } = await import('../providers/openai-research.mjs');
  const { researchChannel } = await import('../ops/research.mjs');
  const secret = process.env.LINE_CHANNEL_SECRET ?? '';
  const allow = new Set((process.env.LINE_ALLOWED_USER_IDS ?? '').split(',').filter(Boolean));
  if (!secret || allow.size === 0) { console.error('Set LINE_CHANNEL_SECRET and LINE_ALLOWED_USER_IDS'); process.exit(1); }
  const store = createPgStore(await connect());
  const images = createImageCache();
  const { createR2, r2Configured } = await import('../storage/r2.mjs');
  const storage = r2Configured() ? createR2() : null;
  console.log(storage ? 'storage: R2' : 'storage: memory only (set R2_* variables)');
  const assets = storage ? async (id) => { const a = await store.getAsset(id); return a ? storage.get(a.r2Key) : null; } : null;
  const gateway = createGateway({ store, adapters: { openai: createOpenAIImageAdapter(), elevenlabs: createElevenLabsAdapter(), render: createRenderAdapter({ storage }), anthropic: createScriptAdapter(), 'openai-text': createScriptAdapter({ vendor: 'openai' }), 'openai-research': createResearchAdapter() } });
  const experts = new Set((process.env.EXPERT_LINE_USER_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  const planProvider = process.env.PLAN_PROVIDER === 'anthropic' ? 'anthropic' : 'openai-text';   // default: OpenAI writes the plan
  console.log(`planner: ${planProvider}`);
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const baseUrl = process.env.PUBLIC_BASE_URL ?? (domain ? `https://${domain}` : '');
  if (!baseUrl) console.error('PUBLIC_BASE_URL / RAILWAY_PUBLIC_DOMAIN not set: image replies will fail');
  const handlers = createHandlers({ store, reply: createLineReply(), push: createLinePush(), gateway, images, storage, baseUrl, contactSheet, planProvider, experts, owners: [...allow], content: createLineContent(), research: (channelId) => researchChannel({ store, gateway, channelId, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date()), force: true }) });
  const { startScheduler } = await import('../ops/digest.mjs');
  startScheduler({ store, push: createLinePush(), owners: [...allow], dailyCapThb: Number(process.env.DAILY_CAP_THB ?? 1000),
    research: (channelId, date) => researchChannel({ store, gateway, channelId, date }) });
  const port = Number(process.env.PORT ?? 8787);
  makeServer({ secret, allow, handlers, images, assets, experts }).listen(port, () => console.log(`listening on ${port}`));
}
