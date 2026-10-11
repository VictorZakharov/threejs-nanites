// The autumn levels on the CPU (src/autumn.ts has the shader side): which stands are green, yellow or red, and how a
// level rides in a tree's wind phase. Plain TypeScript: the planting workers use it too.
import { fbm, mulberry32 } from './noise.ts';

export const STEPS = 7.5; // levels per unit of a
export const TAU = Math.PI * 2;

const standNoise = (x: number, z: number): number => fbm(x / 240 + 41.3, z / 240 - 13.7, 3);
let ranks: number[] | null = null; // the stand noise's distribution, sampled once (its value -> its rank 0..1)
const rankOf = (v: number): number => {
  if (!ranks) {
    const rnd = mulberry32(5);
    ranks = Array.from({ length: 4096 }, () => standNoise((rnd() - 0.5) * 16000, (rnd() - 0.5) * 16000)).sort((a, b) => a - b);
  }
  let lo = 0, hi = ranks.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ranks[m] < v) lo = m + 1; else hi = m; }
  return lo / ranks.length;
};

/**
 * The level (0 green, 1 yellow, 2 red) of a broadleaf tree at (x, z); `jitter` in [0, 1) its own offset; `amount` how
 * far autumn has gone (?autumn=, 0 = summer).
 */
export function autumnAt(x: number, z: number, jitter: number, amount: number): number {
  if (!(amount > 0)) return 0;
  // 40% of the land's trees stay green, 32% yellow, the rest red
  const r = Math.min(0.999, Math.max(0, rankOf(standNoise(x, z)) + (jitter - 0.5) * 0.3 * amount));
  const a = r < 0.4 ? 0 : r < 0.72 ? 0.8 + ((r - 0.4) / 0.32) * 0.4 : 1.55 + ((r - 0.72) / 0.28) * 0.45;
  return Math.min(2, a * Math.min(1, amount));
}

/** The wind phase carrying level `a`. */
export const withAutumn = (phase: number, a: number): number => phase + TAU * Math.round(a * STEPS);
/** The level a tree's wind phase carries (CPU). */
export const autumnOfPhase = (w: number): number => Math.floor(w / TAU) / STEPS;
/** Conifers' fall: a thick mat of needles (the user: "brown/red fir leaves as a thick layer, like real life"). */
export const NEEDLES = 1.3;
/** How much of a tree's leaves lie under it: green 0.2, yellow 0.6, red 1. */
export const fallOf = (a: number): number => 0.2 + 0.4 * a;
