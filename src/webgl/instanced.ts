// What the WebGL mode's instanced plants share (src/webgl/near.ts, forest.ts, statues.ts): the per-instance
// attributes (iA: position and scale; iB: rotation cos/sin, type, wind phase + autumn), the type's values by a
// select chain (one shader for every type), the per-tree jitter of the level radii and the dithered cross-fade over
// the bands where a tree goes from one level to the next (or to its impostor).
import { attribute, float, fract, screenCoordinate, select, sin, dot, uniform, varying, vec2, vec3 } from 'three/tsl';
import { ditherAt, ditherShift } from '../nanite-lib/index.ts';
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

/**
 * The tree's own spread of the level radii (CPU and shader alike, from its scale): in 32-bit floats as the shader
 * multiplies. It read `0.3 * (f + 1) % 1`, (0.3 (f + 1)) mod 1: 1.15-1.45 on the CPU, 0.85-1.15 in the shader, so
 * the scan listed trees in the wrong levels: some drawn by one level only, half their pixels (see-through under
 * TAA), some by none, gone with their shadows (the user; --probe=glnear).
 */
export const jitterCPU = (s: number): number => {
  const x = Math.fround(Math.fround(s) * Math.fround(97.13));
  return 0.85 + 0.3 * (x - Math.floor(x));
};
export const jitter = (s: Float): Float => fract(s.mul(97.13)).mul(0.3).add(0.85);
/** A per-tree random number from its position (float maths: no 32-bit integer hash needed). */
export const hashOf = (a: Vec4): Float => fract(sin(dot(fract(a.xz.mul(0.0137)), vec2(12.9898, 78.233))).mul(43758.5453));
export const rotY = (v: Vec3, b: Vec4): Vec3 => vec3(v.x.mul(b.x).sub(v.z.mul(b.y)), v.y, v.x.mul(b.y).add(v.z.mul(b.x)));

/** The cross-fade band round each level's radius R: R x (1 +- BAND) (?glband=, 0: none, popping). */
export const BAND = Number(new URLSearchParams(location.search).get('glband') ?? 0.06);
/** 1 while the shadow camera (orthographic; the view's is perspective) draws the casters, else 0. */
export const inShadowPass = uniform(0).onObjectUpdate(({ camera }) => ((camera as { isOrthographicCamera?: boolean } | null)?.isOrthographicCamera ? 1 : 0));
/**
 * The screen dither, standing still in the shadow pass: moved every frame there (under TAA), every caster's dithered
 * pixels changed and so did every shadow, a flicker on the ground with the camera still (the user: "flickering
 * shadows, any shadows, anywhere"; `ground` --dolly --step=0 1154 flicker events, 37 without shadows).
 */
export const steadyDither = (): Float => ditherAt(screenCoordinate.xy.sub(ditherShift.mul(inShadowPass)));

/**
 * An impostor's share of the last band, `code` 0.3 + 0.2 t (t: how far across it): it keeps the pixels where the
 * dither is under t, the last near level the rest (near.ts). 0 or under 0.01: drawn whole.
 */
export function fadeKeep(code: Float): Bool {
  const out = code.lessThan(0.275), t = select(out, code.sub(0.05), code.sub(0.3)).div(0.2);
  const d = steadyDither();
  return code.lessThan(0.01).or(out.and(d.greaterThanEqual(t))).or(out.not().and(d.lessThan(t)));
}
