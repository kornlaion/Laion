// Scene splitting is deterministic code, never a model: the owner's words must come out unchanged and in order.
const len = (s) => [...s].length;

/**
 * House rule: one image stays on screen at most 5 seconds. A scene's screen time is its voice-over plus about 1.2 s of
 * fades and pause, and Thai speech runs about 11-13 characters per second, so a scene holds at most ~48 characters.
 * Longer scripts simply get more scenes.
 */
export const MAX_SCENE_CHARS = 48;
const SOFT_ATOM = 24;          // lines longer than this may be cut at the owner's own phrase spaces if the 5 s rule needs it
export const MAX_SCENES = 20;

export function sceneCount(chars) {
  return Math.min(MAX_SCENES, Math.max(3, Math.ceil(chars / (MAX_SCENE_CHARS * 0.85))));   // aim for scenes of ~40 chars, leaving headroom
}

/** Rough on-screen seconds of a scene with this many characters (estimate used for warnings only). */
export const sceneSeconds = (chars) => chars / 11 + 1.2;

let seg;
const words = (s) => { seg ??= new Intl.Segmenter('th', { granularity: 'word' }); return [...seg.segment(s)].map((x) => x.segment); };

/** Break a line into phrase-sized pieces (about SOFT_ATOM characters) at the owner's own spaces; never cuts inside a Thai word without need. */
function atomize(line, soft = SOFT_ATOM, hard = MAX_SCENE_CHARS) {
  if (len(line) <= soft) return [line];
  const pack = (tokens, joiner, max) => {
    const out = []; let cur = '';
    for (const t of tokens) {
      const next = cur ? cur + joiner + t : t;
      if (cur && len(next) > max) { out.push(cur); cur = t; } else cur = next;
    }
    if (cur) out.push(cur);
    return out;
  };
  const tokens = line.split(/\s+/).filter(Boolean).flatMap((t) => (len(t) <= hard ? [t] : pack(words(t), '', hard)));
  return pack(tokens, ' ', soft);
}

/**
 * Split a script into n contiguous scenes of similar length, cutting only between existing lines/paragraphs.
 * Dynamic programming minimises the squared deviation from the average scene length.
 * Lines longer than the 5-second rule are first broken into smaller pieces (only whitespace changes; every character stays, in order).
 * Fewer pieces than n -> one scene per piece. With enforce (default) n is raised until every scene fits the rule;
 * enforce:false keeps exactly n scenes (owner-chosen count) and the caller shows a warning instead. Returns an array of strings (lines inside a scene joined by \n).
 */
export function splitScenes(script, n, { enforce = true } = {}) {
  const parts = String(script).split(/\n+/).map((x) => x.trim()).filter(Boolean).flatMap((x, li) => atomize(x).map((t) => ({ t, li })));
  const units = parts.map((x) => x.t);
  if (enforce) {                                     // never fewer scenes than the 5-second rule needs
    let need = 0, cur = 0;
    for (const u of units) { if (cur && cur + len(u) > MAX_SCENE_CHARS) { need++; cur = 0; } cur += len(u); }
    n = Math.max(n, need + (cur ? 1 : 0));
  }
  if (units.length <= n) return units;
  const w = units.map(len);
  const pre = [0]; for (const x of w) pre.push(pre[pre.length - 1] + x);
  const target = pre[units.length] / n;
  const mid = (j) => (j > 0 && j < parts.length && parts[j - 1].li === parts[j].li ? 120 : 0);   // cutting inside an owner's line costs a little, so cuts prefer line ends
  const cost = (j, i) => (pre[i] - pre[j] - target) ** 2 + mid(j) + (pre[i] - pre[j] > MAX_SCENE_CHARS * 1.15 ? 1e6 : 0);   // a scene over the 5 s rule is almost never chosen
  const INF = Infinity;
  const dp = Array.from({ length: n + 1 }, () => Array(units.length + 1).fill(INF));
  const cut = Array.from({ length: n + 1 }, () => Array(units.length + 1).fill(0));
  dp[0][0] = 0;
  for (let k = 1; k <= n; k++) {
    for (let i = k; i <= units.length; i++) {
      for (let j = k - 1; j < i; j++) {
        const c = dp[k - 1][j] + cost(j, i);
        if (c < dp[k][i]) { dp[k][i] = c; cut[k][i] = j; }
      }
    }
  }
  const groups = [];
  for (let k = n, i = units.length; k >= 1; k--) { const j = cut[k][i]; groups.unshift(units.slice(j, i).join('\n')); i = j; }
  return groups;
}
