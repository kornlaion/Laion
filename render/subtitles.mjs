// Thai subtitle builder: word-aware line breaking (Thai has no spaces) + ASS output for libass.
const seg = new Intl.Segmenter('th', { granularity: 'word' });
const len = (s) => [...s].length;

/** Split text into display lines of at most maxChars, never cutting inside a Thai word. */
export function splitLines(text, maxChars = 16) {
  const out = [];
  for (const para of String(text).split(/\n+/)) {
    let line = '';
    for (const { segment } of seg.segment(para.trim())) {
      if (len(line) + len(segment) > maxChars && line.trim()) { out.push(line.trim()); line = ''; }
      line += segment;
    }
    if (line.trim()) out.push(line.trim());
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
