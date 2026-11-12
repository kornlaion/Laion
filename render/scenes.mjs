// Scene splitting is deterministic code, never a model: the owner's words must come out unchanged and in order.
const len = (s) => [...s].length;

/** 4-6 scenes, about 130 Thai characters each. */
export function sceneCount(chars) {
  return Math.min(6, Math.max(4, Math.round(chars / 130)));
}

/**
 * Split a script into n contiguous scenes of similar length, cutting only between existing lines/paragraphs.
 * Dynamic programming minimises the squared deviation from the average scene length.
 * Fewer lines than n -> one scene per line. Returns an array of strings (lines inside a scene joined by \n).
 */
export function splitScenes(script, n) {
  const units = String(script).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (units.length <= n) return units;
  const w = units.map(len);
  const pre = [0]; for (const x of w) pre.push(pre[pre.length - 1] + x);
  const target = pre[units.length] / n;
  const cost = (j, i) => (pre[i] - pre[j] - target) ** 2;
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
