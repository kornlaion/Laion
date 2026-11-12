import crypto from 'node:crypto';
// Short-lived in-memory image cache so LINE can fetch generated images by an unguessable URL.
// Lost on redeploy by design; permanent storage is Cloudflare R2 (next step).
export function createImageCache({ max = 20, ttlMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const items = new Map();
  return {
    put(buf) {
      const token = crypto.randomBytes(24).toString('hex');
      items.set(token, { buf, at: now() });
      while (items.size > max) items.delete(items.keys().next().value);
      return token;
    },
    get(token) {
      const it = items.get(token);
      if (!it) return null;
      if (now() - it.at > ttlMs) { items.delete(token); return null; }
      return it.buf;
    },
  };
}
