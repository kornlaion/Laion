// Thai subtitle builder: word-aware line breaking (Thai has no spaces) + ASS output for libass.
const seg = new Intl.Segmenter('th', { granularity: 'word' });
// Visual width: Thai vowels above/below and tone marks take no horizontal space.
const len = (s) => [...s.replace(/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g, '')].length;

/** Break one over-long phrase at word boundaries into balanced parts (never an orphan particle on its own line). */
function splitPhrase(phrase, maxChars) {
  const words = [...seg.segment(phrase)].map((x) => x.segment);
  const parts = Math.ceil(len(phrase) / maxChars);
  if (parts <= 1) return [phrase];
  const out = []; let cur = '';
  for (let i = 0; i < words.length; i++) {
    cur += words[i];
    const left = parts - out.length - 1;
    if (left <= 0) continue;
    const target = (len(phrase) - out.reduce((a, l) => a + len(l), 0)) / (left + 1);
    const next = words[i + 1];
    if (next !== undefined && len(cur) + len(next) / 2 >= target) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split text into display lines of at most about maxChars. The author's spaces are phrase boundaries in Thai,
 * so lines break there first; only phrases that are too long are cut, at word boundaries, in balanced pieces.
 */
export function splitLines(text, maxChars = 16) {
  const out = [];
  for (const para of String(text).split(/\n+/)) {
    const phrases = para.trim().split(/\s+/).filter(Boolean).flatMap((p) => (len(p) > maxChars ? splitPhrase(p, maxChars) : [p]));
    let line = '';
    for (const ph of phrases) {
      if (line && len(line) + 1 + len(ph) > maxChars) { out.push(line); line = ph; } else line = line ? `${line} ${ph}` : ph;
    }
    if (line) out.push(line);
  }
  return out;
}

/** Group lines into cues of up to linesPerCue lines; spread durationSec proportionally to text length. */
export function buildCues(text, durationSec, { maxChars = 16, linesPerCue = 2 } = {}) {
  const lines = splitLines(text, maxChars);
  const groups = [];
  for (let i = 0; i < lines.length; i += linesPerCue) groups.push(lines.slice(i, i + linesPerCue));
  const weights = groups.map((g) => g.reduce((s, l) => s + len(l), 0) || 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  return groups.map((g, i) => {
    const d = (weights[i] / total) * durationSec;
    const cue = { start: t, end: t + d, lines: g };
    t += d;
    return cue;
  });
}

const ts = (s) => {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};
const esc = (s) => s.replace(/[{}\\]/g, '');

export function toAss(cues, { font = 'Loma', size = 68, width = 1080, height = 1920, marginV = 280 } = {}) {
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,${marginV},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = cues.map((c) => `Dialogue: 0,${ts(c.start)},${ts(c.end)},Default,,0,0,0,,${c.lines.map(esc).join('\\N')}`);
  return [...head, ...events, ''].join('\n');
}
