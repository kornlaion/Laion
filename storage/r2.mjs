import crypto from 'node:crypto';

// Minimal Cloudflare R2 client (S3-compatible, AWS Signature V4, path-style). No dependencies.
// NOT yet tested against live R2: the first real upload is the test.
const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signRequest({ method, host, path, body, accessKeyId, secretAccessKey, now = new Date(), region = 'auto', service = 's3' }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');          // 20261112T123456Z
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? '');
  const canonicalPath = path.split('/').map(enc).join('/');
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonical = [method, canonicalPath, '', ...names.map((n) => `${n}:${headers[n]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

export function createR2({
  accountId = process.env.R2_ACCOUNT_ID, accessKeyId = process.env.R2_ACCESS_KEY_ID,
  secretAccessKey = process.env.R2_SECRET_ACCESS_KEY, bucket = process.env.R2_BUCKET, fetchImpl = fetch,
} = {}) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const call = async (method, key, body, extra = {}) => {
    const path = `/${bucket}/${key}`;
    const headers = { ...signRequest({ method, host, path, body, accessKeyId, secretAccessKey }), ...extra };
    delete headers.host;
    return fetchImpl(`https://${host}${path.split('/').map(enc).join('/')}`, { method, headers, body });
  };
  return {
    async put(key, buf, contentType = 'application/octet-stream') {
      const res = await call('PUT', key, buf, { 'content-type': contentType });
      if (!res.ok) throw new Error(`r2_put_${res.status}`);
    },
    async get(key) {
      const res = await call('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`r2_get_${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

export const r2Configured = () => ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].every((k) => process.env[k]);
