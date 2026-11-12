import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCues, toAss } from './subtitles.mjs';

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd}_exit_${code}: ${err.split('\n').slice(-4).join(' ')}`))));
});

export async function audioSeconds(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const s = parseFloat(out);
  if (!Number.isFinite(s) || s <= 0) throw new Error('bad_audio_duration');
  return s;
}

// One render at a time: ffmpeg is the heaviest thing this server does.
let tail = Promise.resolve();
const serial = (fn) => { const r = tail.then(fn, fn); tail = r.catch(() => {}); return r; };

/**
 * Still image + voice-over + Thai subtitles -> vertical 1080x1920 MP4 (H.264/AAC).
 * The image slowly pans top to bottom so the frame is not dead.
 */
export function renderVideo({ image, audio, text, font = process.env.SUB_FONT ?? 'Loma', fontsDir = process.env.SUB_FONTS_DIR, maxChars = 16 }) {
  return serial(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'render-'));
    try {
      const img = path.join(dir, 'in.jpg'), aud = path.join(dir, 'in.mp3'), ass = path.join(dir, 'sub.ass'), mp4 = path.join(dir, 'out.mp4');
      await fs.writeFile(img, image); await fs.writeFile(aud, audio);
      const dur = await audioSeconds(aud);
      await fs.writeFile(ass, toAss(buildCues(text, dur, { maxChars }), { font }));
      const total = dur + 0.6;
      const assPath = ass.replace(/\\/g, '/').replace(/:/g, '\\:');
      const subs = `ass='${assPath}'${fontsDir ? `:fontsdir='${fontsDir}'` : ''}`;
      const vf = `scale=-2:2304,crop=1080:1920:x='(iw-1080)/2':y='(ih-1920)*t/${total.toFixed(3)}',${subs},format=yuv420p`;
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-t', total.toFixed(3), '-i', img, '-i', aud,
        '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '30', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', mp4]);
      return { video: await fs.readFile(mp4), seconds: total };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
