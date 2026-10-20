// Material pieces shared by the hardware draws, the software rasterizer's resolve and the impostors (and the
// demo's own materials: the dither, the mip bias).
import {
  uniformArray, uint, float, vec2, vec3, select, max, mix, hash, length, dot, clamp, dFdx, dFdy, log2, fract,
  screenCoordinate, exp2, uniform, fwidth, smoothstep,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { Float, Uint, Vec2, Vec3 } from '../types.ts';

/** A texture layer or type index: a uint, or a float holding a whole number. */
type Index = Uint | Float;

/**
 * Coverage-preserving alpha for the leaf array texture (see coverageScales in alpha.ts): scales alpha by the
 * precomputed factor of the mip level being sampled, so cut-out leaves keep their density at any size.
 */
export function makeLeafAlpha(leafTex: THREE.DataArrayTexture, uvNode: Vec2): (a: Float, layer: Index) => Float {
  const scaled = makeLeafAlphaLod(leafTex);
  return (a, layer) => scaled(a, layer, log2(max(length(dFdx(uvNode)), length(dFdy(uvNode))).mul(leafTex.image.width)).add(mipBias));
}

/** The same with the mip level given (`lod`), for where there are no derivatives (the software rasterizer). */
export function makeLeafAlphaLod(leafTex: THREE.DataArrayTexture): (a: Float, layer: Index, lod: Float) => Float {
  const levels: number = leafTex.userData.levels;
  const scaleArr = uniformArray<'float'>(leafTex.userData.alphaScales, 'float');
  return (a, layer, lodIn) => {
    const lod = clamp(lodIn, 0, levels - 1.001);
    const i0 = uint(layer).mul(levels).add(uint(lod.floor()));
    return a.mul(mix(scaleArr.element(i0), scaleArr.element(i0.add(1)), lod.fract()));
  };
}

const params = new URLSearchParams(location.search);
/** Leaf alpha by coverage against a moving dither (`?leafalpha=dither`, the default under TAA) or a cut-out ('a2c'). */
export const LEAF_DITHER = (params.get('leafalpha') ?? (params.get('taa') === '0' ? 'a2c' : 'dither')) === 'dither';
/** Coverage scale of the software rasterizer's dithered leaf alpha (`?leafcov=`): matches the hardware leaves' colour. */
export const LEAF_COV = Number(params.get('leafcov') ?? 0.9);

/**
 * Alpha to coverage with one sample per pixel (under TAA; the leaf material in draw.ts): three.js's antialiased
 * cut-out, smoothstep(0.5, 0.5 + fwidth(a), a) of the coverage-preserving alpha, against a dither that moves every
 * frame, so only the 1 px edge is dithered and TAA averages it. A leaf's inside stays solid: drawn by the plain
 * filtered alpha instead, a pixel of every card in a crown passed the same per-pixel threshold, so stacked cards
 * didn't add up (5 cards of 20% covered 30%, not 67%): crowns came out pale and see-through, and their holes left
 * nothing for the occlusion culling to hide behind.
 */
export const a2cDither = (a: Float): Float => select(smoothstep(0.5, max(fwidth(a), 1e-4).add(0.5), a).greaterThan(ditherAlt(screenCoordinate.xy)), float(1), float(0));

/** Screen-space dither in [0, 1) (interleaved gradient noise): a fixed pattern, so a cross-fade doesn't shimmer. */
// (`ditherShift` moves the pattern every frame under temporal anti-aliasing, which then averages the dithered leaf
// edges and cross-fades into smooth ones instead of a fixed speckle; the demo's src/taa.ts)
export const ditherShift = uniform(new THREE.Vector2());
/**
 * Mip bias under temporal upscaling (the demo's src/resolution.ts): textures are sampled for the output's pixels, not the
 * scene's (log2 of scene / output pixels, set every frame; 0 without the TAA, which averages the extra detail).
 * Derivative-based footprints (the floor, the cobbles, the coverage scales) are scaled by `footprint()`.
 */
export const mipBias = uniform(0);
export const footprint = (): Float => exp2(mipBias);
export const ditherAt = (xy: Vec2): Float => fract(dot(xy.add(ditherShift), vec2(0.06711056, 0.00583715)).fract().mul(52.9829189));
export const dither = (): Float => ditherAt(screenCoordinate.xy);
/**
 * A second pattern, independent of `dither` at the same pixel, for an alpha test inside the cross-fade (the same
 * noise with transposed coordinates). An offset copy of the first, ditherAt(xy + k), is nearly the same pattern
 * shifted by a constant: among the pixels a tree kept in the cross-fade it passed almost all or almost none, up to
 * 50 points of coverage off, a darker band where trees turn into impostors (the user: the switch line on the fog line).
 */
export const ditherAlt = (xy: Vec2): Float => ditherAt(vec2(xy.y, xy.x).add(vec2(17, 59)));

// debug 4: a flat, unlit colour per tree type, in geometry and impostors alike (harness --typematch masks with it;
// keep in sync with TYPE_IDS in tools/harness/typematch.ts): ten hues 36 degrees apart, told apart by hue (debug 4
// draws them without fog or tone mapping, against the sky: the demo's src/type-masks.ts).
export const TYPE_IDS: number[][] = Array.from({ length: 10 }, (_, i) => { const h = i * 36, f = (n: number) => Math.max(0, Math.min(1, Math.abs(((h / 60 + n) % 6) - 3) - 1)); return [f(0), f(4), f(2)]; });
export const typeId = (type: Index): Vec3 => {
  const col = (i: number): Vec3 => vec3(TYPE_IDS[i][0], TYPE_IDS[i][1], TYPE_IDS[i][2]);
  let c = col(TYPE_IDS.length - 1);
  for (let i = TYPE_IDS.length - 2; i >= 0; i--) c = select(uint(type).mod(TYPE_IDS.length).equal(i), col(i), c);
  return c;
};

// Each tree switches to its impostor at its own size, spread geometrically over [1 / SPREAD, SPREAD] x impostorPx
// (`?impspread=`, 1 = all at once). With one threshold the switch is a line across the forest at a fixed distance
// that slides along with the camera; the real trees shimmer a little in motion and the impostors don't, so that
// moving line was easy to see (the user, on the live site).
const SPREAD = Number(params.get('impspread') ?? 1.6);
/**
 * The projected height (pixels) under which tree `inst` is drawn as an impostor (u: the forest's uniforms). Models
 * (the statues, last in the instances) never are: a handful, cheap as geometry at their coarsest LOD, and their
 * impostors came out as pale blobs from above, some missing (the user: "statues disappear").
 */
export const switchPx = (u: { impostorPx: Float; firstModel: Uint }, inst: Index): Float =>
  select(uint(inst).greaterThanEqual(u.firstModel), float(0), u.impostorPx.mul(exp2(hash(uint(inst).add(101)).mul(2).sub(1).mul(Math.log2(SPREAD)))));
