// Multi-scene ZEN video: one calm image per scene, a separate voice take per scene, soft cross-dissolves,
// breathing pauses between thoughts, an opening title and quiet Thai subtitles.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, audioSeconds, serial } from './render.mjs';
import { buildCues, splitLines } from './subtitles.mjs';

const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fonts');
const FPS = 30;
const frames = (sec) => Math.ceil(sec * FPS) / FPS;
const FADE = 0.8;        // cross-dissolve between scenes
const EXTRA = 0.4;       // extra stillness after a thought (pause = FADE + EXTRA ~ 1.2 s)
const LEAD = 1.2;        // before the first words: title appears
const TAIL = 1.8;        // after the last words, then fade to black

const ts = (s) => {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const esc = (s) => s.replace(/[{}\\]/g, '');

/** Pure timing: returns per-scene start (S), audio start (A), clip length (L) and total length (T). */
export function planTimeline(audioSecs) {
  const n = audioSecs.length;
  const S = [], A = [], L = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const lead = i === 0 ? LEAD : FADE;
    const tail = i === n - 1 ? TAIL : FADE + EXTRA;
    const len = frames(lead + audioSecs[i] + tail);
    S.push(t); A.push(t + lead); L.push(len);
    t += len - (i === n - 1 ? 0 : FADE);
  }
  return { S, A, L, T: S[n - 1] + L[n - 1] };
}

export function zenAss({ scenes, audioSecs, A, title, W, H, subFont = 'Pridi Light', titleFont = 'Pridi', maxChars = 16 }) {
  const k = W / 1080;
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Sub,${subFont},${Math.round(92 * k)},&H00F4F7F9,&H000000FF,&H38000000,&H70000000,0,0,0,0,100,100,${(1.5 * k).toFixed(1)},0,1,${(2 * k).toFixed(1)},${(2 * k).toFixed(1)},2,${Math.round(80 * k)},${Math.round(80 * k)},${Math.round(300 * k)},1`,
    `Style: Title,${titleFont},${Math.round(104 * k)},&H00F4F7F9,&H000000FF,&H40000000,&H70000000,0,0,0,0,100,100,${(2 * k).toFixed(1)},0,1,${(2.5 * k).toFixed(1)},${(3 * k).toFixed(1)},8,${Math.round(90 * k)},${Math.round(90 * k)},${Math.round(420 * k)},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const ev = [];
  if (title) {
    const words = title.trim().split(/\s+/);
    const lines = words.length <= 3 && words.every((w) => [...w].length <= 16) ? words : splitLines(title, 13);
    const t = lines.slice(0, 3).map(esc).join('\\N');
    ev.push(`Dialogue: 1,${ts(0.3)},${ts(LEAD + 2.6)},Title,,0,0,0,,{\\fad(700,900)\\blur2}${t}`);
  }
  scenes.forEach((sc, i) => {
    for (const c of buildCues(sc.text, audioSecs[i], { maxChars, align: sc.align })) {
      ev.push(`Dialogue: 0,${ts(A[i] + c.start)},${ts(A[i] + c.end)},Sub,,0,0,0,,{\\fad(280,280)\\blur1.5}${c.lines.map(esc).join('\\N')}`);
    }
  });
  return [...head, ...ev, ''].join('\n');
}

const panY = (i, H, L) => (i % 2 === 0 ? `(ih-${H})*t/${L.toFixed(3)}` : `(ih-${H})*(1-t/${L.toFixed(3)})`);

/**
 * scenes: [{ image: Buffer, audio: Buffer, text: string, clip?: Buffer, align?: {characters, starts, ends} }]  ->  { video: Buffer, seconds }
 * A scene with `clip` (e.g. a Veo video the owner made) uses the clip instead of the pan-and-zoom still; a clip shorter than the scene holds its last frame.
 * Size and threads are limited on purpose (see render.mjs): RENDER_WIDTH (default 720; 1080 when the plan has the memory).
 */
export function renderZen({
  scenes, title, width = Number(process.env.RENDER_WIDTH ?? 720), threads = Number(process.env.RENDER_THREADS ?? 1),
  subFont = process.env.SUB_FONT ?? 'Pridi Light', titleFont = process.env.TITLE_FONT ?? 'Pridi',
}) {
  return serial(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-'));
    try {
      const W = Math.round(width / 2) * 2, H = Math.round((W * 16) / 9 / 2) * 2, SH = Math.round((H * 1.2) / 2) * 2;
      const n = scenes.length;
      const audioSecs = [];
      for (let i = 0; i < n; i++) {
        await fs.writeFile(path.join(dir, `i${i}.jpg`), scenes[i].image);
        await fs.writeFile(path.join(dir, `a${i}.mp3`), scenes[i].audio);
        audioSecs.push(await audioSeconds(path.join(dir, `a${i}.mp3`)));
      }
      const { S, A, L, T } = planTimeline(audioSecs);
      // Scenes with a clip: normalise it once to the scene length (+0.6 s margin for the cross-fade), silent, same size/fps/colour as the stills.
      const hasClip = scenes.map((sc) => Boolean(sc.clip));
      for (let i = 0; i < n; i++) {
        if (!hasClip[i]) continue;
        await fs.writeFile(path.join(dir, `k${i}.src`), scenes[i].clip);
        await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(dir, `k${i}.src`), '-an',
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},tpad=stop_mode=clone:stop_duration=${(L[i] + 1).toFixed(3)},eq=saturation=0.92,format=yuv420p`,
          '-t', (L[i] + 0.6).toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', String(FPS), '-threads', String(threads), path.join(dir, `c${i}.mp4`)]);
      }
      // Input spec + filter for scene i starting t0 seconds in, lasting dur: a clip or the panned still.
      const src = (i, t0, dur) => (hasClip[i]
        ? ['-ss', t0.toFixed(3), '-t', dur.toFixed(3), '-i', path.join(dir, `c${i}.mp4`)]
        : ['-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', path.join(dir, `i${i}.jpg`)]);
      const vf = (i, t0) => (hasClip[i] ? `setpts=PTS-STARTPTS,fps=${FPS},settb=1/${FPS},format=yuv420p` : pan(i, t0));

      // 1) Video is built from short pieces, never from N parallel inputs (that cost ~690MB at 1080p; pieces stay near one encoder's footprint):
      //    body_0, dissolve_0, body_1, dissolve_1 ... body_last. Each piece is rendered straight from its image with a slow pan
      //    (direction alternates per scene); a dissolve piece cross-fades the end of scene i into the start of scene i+1.
      const enc = (outFile) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', String(FPS), '-g', String(FPS), '-threads', String(threads), outFile];
      const pan = (i, t0) => `scale=-2:${SH},crop=${W}:${H}:x='(iw-${W})/2':y='${i % 2 === 0 ? `(ih-${H})*(${t0.toFixed(3)}+t)/${L[i].toFixed(3)}` : `(ih-${H})*(1-(${t0.toFixed(3)}+t)/${L[i].toFixed(3)})`}',eq=saturation=0.92,format=yuv420p`;
      const pieces = [];
      const body = async (i, t0, dur) => {
        const f = path.join(dir, `p${pieces.length}.mp4`);
        await run('ffmpeg', ['-y', '-loglevel', 'error', ...src(i, t0, dur), '-vf', vf(i, t0), ...enc(f)]);
        pieces.push(f);
      };
      const dissolve = async (i) => {
        const f = path.join(dir, `p${pieces.length}.mp4`);
        const fr = Math.round(FADE * FPS);
        await run('ffmpeg', ['-y', '-loglevel', 'error',
          ...src(i, L[i] - FADE, FADE + 0.3), ...src(i + 1, 0, FADE + 0.3),
          '-filter_complex', `[0:v]${vf(i, L[i] - FADE)}[a];[1:v]${vf(i + 1, 0)}[b];[a][b]xfade=transition=fade:duration=${FADE}:offset=0,format=yuv420p[o]`,
          '-map', '[o]', '-frames:v', String(fr), ...enc(f)]);
        pieces.push(f);
      };
      if (n === 1) await body(0, 0, L[0]);
      else {
        await body(0, 0, L[0] - FADE);
        for (let i = 0; i < n - 1; i++) {
          await dissolve(i);
          const last = i + 1 === n - 1;
          await body(i + 1, FADE, last ? L[i + 1] - FADE : L[i + 1] - 2 * FADE);
        }
      }
      const list = path.join(dir, 'list.txt');
      await fs.writeFile(list, pieces.map((f) => `file '${f}'`).join('\n'));
      const joined = path.join(dir, 'joined.mp4');
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);

      // 2) subtitles + title burned in, one pass over the joined video; voice takes placed on the timeline
      const ass = path.join(dir, 'sub.ass');
      await fs.writeFile(ass, zenAss({ scenes, audioSecs, A, title, W, H, subFont, titleFont }));
      const assPath = ass.replace(/\\/g, '/').replace(/:/g, '\\:');
      const parts = [`[0:v]ass='${assPath}':fontsdir='${FONTS_DIR}',vignette=PI/6,fade=t=out:st=${(T - 1.4).toFixed(3)}:d=1.4,format=yuv420p[v]`];
      for (let i = 0; i < n; i++) {
        const ms = Math.round(A[i] * 1000);
        parts.push(`[${i + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms}[a${i}]`);
      }
      parts.push(`${scenes.map((_, i) => `[a${i}]`).join('')}amix=inputs=${n}:normalize=0:duration=longest,afade=t=out:st=${(T - 1.4).toFixed(3)}:d=1.4[a]`);
      const out = path.join(dir, 'out.mp4');
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-threads', '1', '-i', joined,
        ...scenes.flatMap((_, i) => ['-i', path.join(dir, `a${i}.mp3`)]),
        '-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[a]', '-t', T.toFixed(3),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-r', String(FPS), '-threads', String(threads), '-filter_complex_threads', '1',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
      return { video: await fs.readFile(out), seconds: T };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

/** One overview picture of all scene images (3 columns), so a single LINE message shows the whole storyboard. */
export function contactSheet(images, { cols = 3, cellW = 360, cellH = 540 } = {}) {
  return serial(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-'));
    try {
      const n = images.length;
      for (let i = 0; i < n; i++) await fs.writeFile(path.join(dir, `i${i}.jpg`), images[i]);
      const rows = Math.ceil(n / cols);
      const cells = images.map((_, i) => `[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=increase,crop=${cellW}:${cellH},setsar=1[v${i}]`);
      const cat = `${images.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[c];[c]tile=${cols}x${rows}:padding=8:margin=8:color=0x1c201b[o]`;
      const out = path.join(dir, 'sheet.jpg');
      await run('ffmpeg', ['-y', '-loglevel', 'error', ...images.flatMap((_, i) => ['-i', path.join(dir, `i${i}.jpg`)]),
        '-filter_complex', [...cells, cat].join(';'), '-map', '[o]', '-frames:v', '1', '-q:v', '4', out]);
      return await fs.readFile(out);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
