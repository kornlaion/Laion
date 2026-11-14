// Music-led video: one excerpt of the owner's own song is the soundtrack; a new picture appears at each lyric line
// (never held longer than the owner's 5-second rule); the lyrics are the subtitles, timed to the singing.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, serial } from './render.mjs';
import { stitchScenes, zenAss } from './zen.mjs';
import { splitLines } from './subtitles.mjs';

const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fonts');
const FPS = 30;
const FADE = 0.8;
const ts = (s) => {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const esc = (s) => s.replace(/[{}\\]/g, '');

/** bounds: [0, b1, ..., T] in seconds. Cross-dissolves are centred on each bound, so the picture changes ON the lyric/beat. */
export function planMusicTimeline(bounds) {
  const n = bounds.length - 1, L = [];
  for (let i = 0; i < n; i++) {
    const start = i === 0 ? 0 : bounds[i] - FADE / 2;
    const end = i === n - 1 ? bounds[n] : bounds[i + 1] + FADE / 2;
    L.push(end - start);
  }
  return { L, T: bounds[n] };
}

/**
 * song: Buffer (mp3/m4a/wav) of the WHOLE song; start: excerpt start in the song (seconds); bounds: scene edges relative to the excerpt;
 * scenes: [{ image: Buffer, clip?: Buffer }]; lines: [{ text, start, end }] relative to the excerpt.
 */
export function renderMusic({
  song, start, bounds, scenes, lines,
  width = Number(process.env.RENDER_WIDTH ?? 720), threads = Number(process.env.RENDER_THREADS ?? 1),
  subFont = process.env.SUB_FONT ?? 'Pridi Light',
}) {
  return serial(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-'));
    try {
      if (scenes.length !== bounds.length - 1) throw new Error('scene_bounds_mismatch');
      const W = Math.round(width / 2) * 2, H = Math.round((W * 16) / 9 / 2) * 2, SH = Math.round((H * 1.2) / 2) * 2;
      for (let i = 0; i < scenes.length; i++) await fs.writeFile(path.join(dir, `i${i}.jpg`), scenes[i].image);
      const { L, T } = planMusicTimeline(bounds);
      const joined = await stitchScenes(dir, { scenes, L, W, H, SH, threads });
      const ass = path.join(dir, 'sub.ass');
      const k = W / 1080;
      const head = zenAss({ scenes: [], audioSecs: [], A: [], title: undefined, W, H, subFont }).replace(`,${Math.round(92 * k)},`, `,${Math.round(76 * k)},`);   // lyric lines are longer than voice-over cues: a little smaller
      // A cue never overlaps the next one (libass would stack overlapping cues upward and the text would jump).
      const ev = lines.map((l, i) => {
        const a = Math.max(0, l.start - 0.1);
        const nextA = i + 1 < lines.length ? Math.max(0, lines[i + 1].start - 0.1) : Infinity;
        const b = Math.min(T, nextA - 0.05, i + 1 < lines.length ? l.end + 3 : l.end + 0.6);
        const t = splitLines(l.text, 22).map(esc).join('\\N');
        return `Dialogue: 0,${ts(a)},${ts(Math.max(a + 0.4, b))},Sub,,0,0,0,,{\\fad(250,250)\\blur1.5}${t}`;
      });
      await fs.writeFile(ass, `${head.trimEnd()}\n${ev.join('\n')}\n`);
      const assPath = ass.replace(/\\/g, '/').replace(/:/g, '\\:');
      const songFile = path.join(dir, 'song.src');
      await fs.writeFile(songFile, song);
      const out = path.join(dir, 'out.mp4');
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-threads', '1', '-i', joined, '-ss', Math.max(0, start).toFixed(3), '-t', T.toFixed(3), '-i', songFile,
        '-filter_complex', `[0:v]ass='${assPath}':fontsdir='${FONTS_DIR}',vignette=PI/6,fade=t=out:st=${(T - 1.0).toFixed(3)}:d=1.0,format=yuv420p[v];[1:a]aformat=sample_rates=44100:channel_layouts=stereo,afade=t=in:st=0:d=0.5,afade=t=out:st=${(T - 1.6).toFixed(3)}:d=1.6[a]`,
        '-map', '[v]', '-map', '[a]', '-t', T.toFixed(3),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-r', String(FPS), '-threads', String(threads), '-filter_complex_threads', '1',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
      return { video: await fs.readFile(out), seconds: T };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

/** Cut [start, start+dur) of an audio file into a small mono mp3 (for transcription) or return the converted full song as mp3. */
export function cutAudio(buf, { start = 0, dur, mono = true, bitrate = '64k' } = {}) {
  return serial(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cut-'));
    try {
      await fs.writeFile(path.join(dir, 'in.src'), buf);
      const out = path.join(dir, 'out.mp3');
      await run('ffmpeg', ['-y', '-loglevel', 'error', ...(start ? ['-ss', String(start)] : []), '-i', path.join(dir, 'in.src'), ...(dur ? ['-t', String(dur)] : []), '-vn', '-ac', mono ? '1' : '2', '-ar', mono ? '16000' : '44100', '-b:a', bitrate, out]);
      return await fs.readFile(out);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

/** Length in seconds of an audio buffer (ffprobe). */
export function audioDuration(buf) {
  return serial(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dur-'));
    try {
      await fs.writeFile(path.join(dir, 'a.src'), buf);
      const s = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(dir, 'a.src')]));
      if (!Number.isFinite(s) || s <= 0) throw new Error('bad_audio_duration');
      return s;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
