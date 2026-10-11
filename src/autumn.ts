// Autumn: broadleaf trees and bushes turn green, yellow or red, in stands (noise) with each tree a little off its
// stand, and the leaves under them match: more of them the further they've turned (`?autumn=` scales it, 0 = summer).
// A tree's level a (0 green, 1 yellow, 2 red) travels in its wind phase (instance b.w) as whole turns: phase + 2 pi L,
// a = L / STEPS, so the wind's sines don't change and the instance buffers keep their size.
import { float, vec3, mix, clamp, dot } from 'three/tsl';
import { autumnAt as autumnAtCpu, STEPS, TAU } from './autumn-cpu.ts';
import type { Float, Vec3 } from './types.ts';

/** How far autumn has gone (?autumn=, 0 = summer). */
export const AUTUMN = Number(new URLSearchParams(location.search).get('autumn') ?? 1);

/** The level (0 green, 1 yellow, 2 red) of a broadleaf tree at (x, z) under ?autumn= (see autumn-cpu.ts). */
export const autumnAt = (x: number, z: number, jitter: number): number => autumnAtCpu(x, z, jitter, AUTUMN);
export { withAutumn, autumnOfPhase, NEEDLES, fallOf } from './autumn-cpu.ts';

/** The same in a shader. */
export const autumnOf = (w: Float): Float => w.div(TAU).floor().div(STEPS);

/**
 * Leaf colour turned to level `a` where `mask` is 1: towards yellow, then red, at the same luminance-ish (yellow a
 * little brighter, like the real thing). The impostors pass a mask of how green the texel is (their atlas has bark).
 */
export function autumnColour(rgb: Vec3, a: Float, mask: Float = float(1)): Vec3 {
  const lum = dot(rgb, vec3(0.3, 0.59, 0.11));
  const target = mix(vec3(1.9, 1.45, 0.2), vec3(2.3, 0.5, 0.18), clamp(a.sub(1), 0, 1)).mul(lum);
  return mix(rgb, target, clamp(a, 0, 1).mul(mask));
}
