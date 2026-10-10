// Autumn: broadleaf trees and bushes turn green, yellow or red, in stands (noise) with each tree a little off its
// stand, and the leaves under them match: more of them the further they've turned (`?autumn=` scales it, 0 = summer).
// A tree's level a (0 green, 1 yellow, 2 red) travels in its wind phase (instance b.w) as whole turns: phase + 2 pi L,
// a = L / STEPS, so the wind's sines don't change and the instance buffers keep their size.
import { float, vec3, mix, clamp, dot } from 'three/tsl';
import { fbm } from './terrain.ts';
import type { Float, Vec3 } from './types.ts';

const STEPS = 7.5; // levels per unit of a
const TAU = Math.PI * 2;
const AUTUMN = Number(new URLSearchParams(location.search).get('autumn') ?? 1);

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

/** The level (0 green, 1 yellow, 2 red) of a broadleaf tree at (x, z); `jitter` in [0, 1) its own offset. */
export function autumnAt(x: number, z: number, jitter: number): number {
  if (!(AUTUMN > 0)) return 0;
  // 40% of the land's trees stay green, 32% yellow, the rest red
  const r = Math.min(0.999, Math.max(0, rankOf(standNoise(x, z)) + (jitter - 0.5) * 0.3 * AUTUMN));
  const a = r < 0.4 ? 0 : r < 0.72 ? 0.8 + ((r - 0.4) / 0.32) * 0.4 : 1.55 + ((r - 0.72) / 0.28) * 0.45;
  return Math.min(2, a * Math.min(1, AUTUMN));
}

/** The wind phase carrying level `a`. */
export const withAutumn = (phase: number, a: number): number => phase + TAU * Math.round(a * STEPS);
/** The level a tree's wind phase carries (CPU). */
export const autumnOfPhase = (w: number): number => Math.floor(w / TAU) / STEPS;
/** The same in a shader. */
export const autumnOf = (w: Float): Float => w.div(TAU).floor().div(STEPS);
/** How much of a tree's leaves lie under it: green 0.2, yellow 0.6, red 1. */
export const fallOf = (a: number): number => 0.2 + 0.4 * a;

/**
 * Leaf colour turned to level `a` where `mask` is 1: towards yellow, then red, at the same luminance-ish (yellow a
 * little brighter, like the real thing). The impostors pass a mask of how green the texel is (their atlas has bark).
 */
export function autumnColour(rgb: Vec3, a: Float, mask: Float = float(1)): Vec3 {
  const lum = dot(rgb, vec3(0.3, 0.59, 0.11));
  const target = mix(vec3(1.9, 1.45, 0.2), vec3(2.3, 0.5, 0.18), clamp(a.sub(1), 0, 1)).mul(lum);
  return mix(rgb, target, clamp(a, 0, 1).mul(mask));
}
