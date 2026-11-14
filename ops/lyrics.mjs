// Lyrics helpers for the music-led format (pure functions, no I/O).
// Own songs: the owner sends the lyrics text; timing comes from an LRC-style paste, or from a transcript of the excerpt
// (word timestamps) matched against the lyrics. Nothing here talks to a provider.

const SECTION = /^(?:intro|verse|pre[- ]?chorus|chorus|hook|bridge|outro|final chorus|interlude|instrumental)(?:\s*\d+)?(?:\s*[/&]\s*[a-z]+(?:\s*\d+)?)*\s*:?$/i;
const LRC = /^\s*\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/;

/** "1:33" -> 93, "93" -> 93, "1:33.5" -> 93.5. null when it does not parse. */
export function parseClock(s) {
  const m = String(s ?? '').trim().match(/^(?:(\d{1,2}):)?(\d{1,3})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0);
}

/** Lyrics text -> plain lines (section tags, links and blank lines removed) and, when the text carries [mm:ss.xx] stamps, a timed list. */
export function parseLyrics(text) {
  const lines = []; const timed = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const lrc = line.match(LRC);
    if (lrc) {
      const t = Number(lrc[1]) * 60 + Number(lrc[2]) + (lrc[3] ? Number(`0.${lrc[3]}`) : 0);
      const body = lrc[4].trim();
      if (body) { timed.push({ text: body, time: t }); lines.push(body); }
      continue;
    }
    if (/^\[.*\]\(https?:\/\/.*\)$/.test(line)) continue;           // a markdown link line (song page)
    if (/^\[[^\]]*\]$/.test(line)) continue;                         // [Verse 1]
    line = line.replace(/^\[[^\]]*\]\s*/, '');                       // "[Chorus] ฉันจะรอ" -> keep the words
    if (SECTION.test(line)) continue;                                // Verse 1 / Hook / Bridge on its own line
    if (line) lines.push(line);
  }
  return { lines, timed: timed.length >= 2 && timed.length === lines.length ? timed : null };
}

// Matching skeleton: letters and marks only, tone marks and repeat marks dropped (transcripts get these wrong most often).
const keep = (ch) => /[\p{L}\p{M}\p{N}]/u.test(ch) && !/[่-์ๆ]/.test(ch);
const skeleton = (s) => [...String(s)].filter(keep);

/**
 * Match a transcript (words with times) against the lyrics lines with a local alignment (Smith-Waterman on characters).
 * words: [{ word, start, end }]  (seconds from the start of the excerpt)
 * returns { lines: [{ index, text, start, end, matched }], confidence } where confidence = share of transcript characters that matched.
 * Lines between the first and last matched line are kept (timed by interpolation when nothing matched in them).
 */
export function alignLyrics(lyricLines, words, { minConfidence = 0.3 } = {}) {
  const T = []; // transcript characters with time
  for (const w of words ?? []) {
    const cs = skeleton(w.word);
    cs.forEach((ch, i) => T.push({ ch, t: w.start + ((w.end - w.start) * (i + 0.5)) / cs.length, s: w.start + ((w.end - w.start) * i) / cs.length, e: w.start + ((w.end - w.start) * (i + 1)) / cs.length }));
  }
  const Lc = [];
  lyricLines.forEach((line, li) => { for (const ch of skeleton(line)) Lc.push({ ch, li }); });
  if (!T.length || !Lc.length) return { lines: [], confidence: 0 };
  const n = T.length, m = Lc.length, W = m + 1;
  const H = new Int16Array((n + 1) * W);
  const dir = new Uint8Array((n + 1) * W);                           // 1 diag, 2 up (skip transcript), 3 left (skip lyric)
  let best = 0, bi = 0, bj = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = H[(i - 1) * W + j - 1] + (T[i - 1].ch === Lc[j - 1].ch ? 2 : -1);
      const u = H[(i - 1) * W + j] - 1, l = H[i * W + j - 1] - 1;
      let v = 0, k = 0;
      if (d > v) { v = d; k = 1; }
      if (u > v) { v = u; k = 2; }
      if (l > v) { v = l; k = 3; }
      H[i * W + j] = v; dir[i * W + j] = k;
      if (v > best) { best = v; bi = i; bj = j; }
    }
  }
  const hits = new Map();                                            // lyric line -> matched transcript chars
  let matchedChars = 0;
  for (let i = bi, j = bj; i > 0 && j > 0 && H[i * W + j] > 0;) {
    const k = dir[i * W + j];
    if (k === 1) {
      if (T[i - 1].ch === Lc[j - 1].ch) { const a = hits.get(Lc[j - 1].li) ?? []; a.push(T[i - 1]); hits.set(Lc[j - 1].li, a); matchedChars++; }
      i--; j--;
    } else if (k === 2) i--; else j--;
  }
  const confidence = matchedChars / n;
  if (confidence < minConfidence || !hits.size) return { lines: [], confidence };
  const idx = [...hits.keys()].sort((a, b) => a - b);
  const first = idx[0], last = idx[idx.length - 1];
  const out = [];
  for (let li = first; li <= last; li++) {
    const h = hits.get(li);
    const total = skeleton(lyricLines[li]).length || 1;
    if (h && h.length / total >= 0.35) out.push({ index: li, text: lyricLines[li], start: Math.min(...h.map((x) => x.s)), end: Math.max(...h.map((x) => x.e)), matched: h.length / total });
    else out.push({ index: li, text: lyricLines[li], start: NaN, end: NaN, matched: 0 });
  }
  // lines at the edges that matched only a few characters are the neighbouring phrase leaking in: drop them
  while (out.length > 1 && out[0].matched < 0.35) out.shift();
  while (out.length > 1 && out.at(-1).matched < 0.35) out.pop();
  // interpolate untimed interior lines between their timed neighbours, weighted by length
  for (let a = 0; a < out.length; a++) {
    if (!Number.isNaN(out[a].start)) continue;
    let b = a; while (b < out.length && Number.isNaN(out[b].start)) b++;
    const t0 = out[a - 1].end, t1 = out[b]?.start ?? t0 + 2 * (b - a);
    const w = out.slice(a, b).map((x) => skeleton(x.text).length || 1), tot = w.reduce((x, y) => x + y, 0);
    let t = t0;
    for (let k = a; k < b; k++) { const d = ((t1 - t0) * w[k - a]) / tot; out[k].start = t; out[k].end = t + d; t += d; }
  }
  for (let a = 1; a < out.length; a++) if (out[a].start < out[a - 1].end) out[a - 1].end = Math.max(out[a - 1].start + 0.3, out[a].start);   // never overlap
  return { lines: out, confidence };
}

/** Timed lyrics (LRC) -> lines inside [from, to), times relative to `from`. */
export function linesFromLrc(timed, from, to) {
  const out = [];
  timed.forEach((x, i) => {
    if (x.time < from - 0.05 || x.time >= to) return;
    const next = timed[i + 1]?.time ?? x.time + 4;
    out.push({ index: i, text: x.text, start: Math.max(0, x.time - from), end: Math.min(to, Math.max(x.time + 0.5, next - 0.05)) - from });
  });
  return out;
}

/**
 * Cut the excerpt into scenes: a new picture at each lyric line (and never longer than maxScene seconds).
 * lines: [{ text, start, end }] relative to the excerpt; duration: excerpt length in seconds.
 * returns { bounds: [0, ..., duration], scenes: [{ start, end, lines: [lineIndex...] }] }
 */
export function planScenes(lines, duration, { maxScene = 5, minScene = 2.5 } = {}) {
  let cuts = [0, ...lines.map((l) => l.start).filter((t) => t > 0 && t < duration), duration].sort((a, b) => a - b);
  const keepCuts = [cuts[0]];
  for (let i = 1; i < cuts.length - 1; i++) if (cuts[i] - keepCuts.at(-1) >= minScene && duration - cuts[i] >= minScene) keepCuts.push(cuts[i]);
  keepCuts.push(duration);
  const bounds = [keepCuts[0]];
  for (let i = 1; i < keepCuts.length; i++) {
    const a = keepCuts[i - 1], b = keepCuts[i];
    const parts = Math.max(1, Math.ceil((b - a) / maxScene - 1e-9));
    for (let p = 1; p <= parts; p++) bounds.push(a + ((b - a) * p) / parts);
  }
  const scenes = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [a, b] = [bounds[i], bounds[i + 1]];
    scenes.push({ start: a, end: b, lines: lines.map((l, k) => [l, k]).filter(([l]) => l.start >= a - 0.05 && l.start < b - 0.05).map(([, k]) => k) });
  }
  return { bounds, scenes };
}
