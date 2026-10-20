// What the WebGL mode's instanced plants share (src/webgl/near.ts, forest.ts, statues.ts): the per-instance
// attributes (iA: position and scale; iB: rotation cos/sin, type, wind phase + autumn), the type's values by a
// select chain (one shader for every type), the per-tree jitter of the level radii and the dithered cross-fade over
// the bands where a tree goes from one level to the next (or to its impostor).
import { attribute, float, fract, select, sin, dot, varying, vec2, vec3 } from 'three/tsl';
import { dither } from '../nanite/shading.ts';
import type { Bool, Float, Vec3, Vec4 } from '../types.ts';

export const iA = attribute<'vec4'>('iA', 'vec4'), iB = attribute<'vec4'>('iB', 'vec4');
/**
 * The type (iB.z's whole part). Its fraction, always under 0.5, carries a copy's own data: the tree's rank in an
 * impostor cell, or a near tree's cross-fade (`fadeCode`). +0.25: interpolated into the fragment stage, 3 can arrive
 * as 2.9999, and the trunks were speckled with another type's bark.
 */
export const typeOf = iB.z.add(0.25).floor();
/** The tree's type's value from a list (a select chain: one shader for every type). */
export const pick = (values: number[]): Float => values.slice(0, -1).reduceRight<Float>((acc, v, i) => select(typeOf.equal(i), float(v), acc), float(values[values.length - 1]));
/**
 * The instance's attributes for nodes first built in a Lambert's emissive (the debug colours), through varyings:
 * read from the attributes there they were 0 (`?debug=4` showed every tree as type 0). Values the colour has built
 * already are reused and fine. (Not typeOf itself as a varying: the vertex stage reads it too, and the bark's layers
 * came out wrong.)
 */
export const iAf = varying(iA, 'vGlIA'), iBf = varying(iB, 'vGlIB');
export const typeOfF = iBf.z.add(0.25).floor();

/** The tree's own spread of the level radii (CPU and shader alike, from its scale). */
export const jitterCPU = (s: number): number => 0.85 + 0.3 * (((s * 97.13) % 1) + 1) % 1;
export const jitter = (s: Float): Float => fract(s.mul(97.13)).mul(0.3).add(0.85);
/** A per-tree random number from its position (float maths: no 32-bit integer hash needed). */
export const hashOf = (a: Vec4): Float => fract(sin(dot(fract(a.xz.mul(0.0137)), vec2(12.9898, 78.233))).mul(43758.5453));
export const rotY = (v: Vec3, b: Vec4): Vec3 => vec3(v.x.mul(b.x).sub(v.z.mul(b.y)), v.y, v.x.mul(b.y).add(v.z.mul(b.x)));

/** The cross-fade band round each level's radius R: R x (1 +- BAND) (?glband=, 0: none, popping). */
export const BAND = Number(new URLSearchParams(location.search).get('glband') ?? 0.06);
/** How far across the band at radius R a tree at distance d is (0 inside, 1 past it). */
export const across = (d: number, R: number): number => (BAND <= 0 ? (d < R ? 0 : 1) : Math.min(1, Math.max(0, (d - R * (1 - BAND)) / (2 * BAND * R))));
/**
 * A near copy's cross-fade, in iB.z's fraction: 0 drawn whole; `out` (the level it leaves, in the band at its outer
 * radius) where the dither is over t, else (the one it enters) where it's under t: the two copies split the pixels.
 */
export const fadeCode = (t: number, out: boolean): number => (out ? 0.05 + 0.2 * t : 0.3 + 0.2 * t);
/** Whether this pixel of the copy is drawn (fragment stage; `code` the fraction, read in the vertex stage). */
export function fadeKeep(code: Float): Bool {
  const out = code.lessThan(0.275), t = select(out, code.sub(0.05), code.sub(0.3)).div(0.2);
  const d = dither();
  return code.lessThan(0.01).or(out.and(d.greaterThanEqual(t))).or(out.not().and(d.lessThan(t)));
}
