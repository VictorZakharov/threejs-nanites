// Material pieces shared by the hardware draws, the software rasterizer's resolve and the impostors.
import {
  uniformArray, uint, float, vec2, vec3, select, max, mix, hash, length, dot, clamp, dFdx, dFdy, log2, fract,
  screenCoordinate, exp2, uniform,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { Float, Uint, Vec2, Vec3 } from '../types.ts';
import { autumnColour } from '../autumn.ts';

/** A texture layer or type index: a uint, or a float holding a whole number. */
type Index = Uint | Float;

/**
 * Coverage-preserving alpha for the leaf array texture (see coverageScales in textures.js): scales alpha by the
 * precomputed factor of the mip level being sampled, so cut-out leaves keep their density at any size.
 */
export function makeLeafAlpha(leafTex: THREE.DataArrayTexture, uvNode: Vec2): (a: Float, layer: Index) => Float {
  const scaled = makeLeafAlphaLod(leafTex);
  return (a, layer) => scaled(a, layer, log2(max(length(dFdx(uvNode)), length(dFdy(uvNode))).mul(leafTex.image.width)));
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

/** Leaf colour before lighting (shared by the hardware draw and the software rasterizer's resolve); `autumn`: the
 * tree's level (src/autumn.ts; pine needles, layer 3, stay green). */
export function leafColour(rgb: Vec3, layerI: Float, tint: Float, autumn: Float): Vec3 {
  // per-tree hue variation, x 0.76 (meant as "darker towards the bottom of the crown" from the normal, but the
  // fragment stage's normalLocal is the geometry's zero normal attribute, so it always was this constant, and the
  // impostor colours are calibrated against it)
  const inner = 0.76;
  // per-texture tint (layer 2 = aspen, an autumn-yellow texture: pull it back to summer green)
  // and layer 3 = pine, olive needles that read yellow in full sun: darker, bluer)
  const layerTint = select(
    layerI.equal(2),
    vec3(0.5, 0.82, 0.85),
    select(layerI.equal(3), vec3(0.62, 0.78, 1.0), vec3(1)),
  );
  const col = rgb.mul(layerTint).mul(vec3(tint.mul(0.92), tint, tint.mul(0.8))).mul(inner).mul(1.2);
  return autumnColour(col, autumn, select(layerI.equal(3), float(0), float(1)));
}

/** Bark colour before lighting. */
export const barkColour = (rgb: Vec3): Vec3 => rgb.mul(vec3(0.9, 0.86, 0.8));

/** Per-tree brightness variation. */
export const treeTint = (inst: Uint): Float => hash(inst).mul(0.35).add(0.8);

/** Screen-space dither in [0, 1) (interleaved gradient noise): a fixed pattern, so a cross-fade doesn't shimmer. */
// (`ditherShift` moves the pattern every frame under temporal anti-aliasing, which then averages the dithered leaf
// edges and cross-fades into smooth ones instead of a fixed speckle; see src/taa.js)
export const ditherShift = uniform(new THREE.Vector2());
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
// keep in sync with TYPE_IDS in tools/harness/typematch.mjs): ten hues 36 degrees apart, told apart by hue after
// fog and tone mapping; the dull olive ground and pale sky aren't saturated enough to count.
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
const SPREAD = Number(new URLSearchParams(location.search).get('impspread') ?? 1.6);
/** The projected height (pixels) under which tree `inst` is drawn as an impostor (u: the forest's uniforms). */
export const switchPx = (u: { impostorPx: Float }, inst: Index): Float => u.impostorPx.mul(exp2(hash(uint(inst).add(101)).mul(2).sub(1).mul(Math.log2(SPREAD))));
