// Material pieces shared by the hardware draws, the software rasterizer's resolve and the impostors.
import {
  uniformArray, uint, float, vec2, vec3, select, max, mix, hash, length, dot, clamp, dFdx, dFdy, log2, fract,
  screenCoordinate,
} from 'three/tsl';

/**
 * Coverage-preserving alpha for the leaf array texture (see coverageScales in textures.js): scales alpha by the
 * precomputed factor of the mip level being sampled, so cut-out leaves keep their density at any size.
 */
export function makeLeafAlpha(leafTex, uvNode) {
  const levels = leafTex.userData.levels;
  const scaled = makeLeafAlphaLod(leafTex);
  return (a, layer) => scaled(a, layer, log2(max(length(dFdx(uvNode)), length(dFdy(uvNode))).mul(leafTex.image.width)));
}

/** The same with the mip level given (`lod`), for where there are no derivatives (the software rasterizer). */
export function makeLeafAlphaLod(leafTex) {
  const levels = leafTex.userData.levels;
  const scaleArr = uniformArray(leafTex.userData.alphaScales, 'float');
  return (a, layer, lodIn) => {
    const lod = clamp(lodIn, 0, levels - 1.001);
    const i0 = uint(layer).mul(levels).add(uint(lod.floor()));
    return a.mul(mix(scaleArr.element(i0), scaleArr.element(i0.add(1)), lod.fract()));
  };
}

/** Leaf colour before lighting (shared by the hardware draw and the software rasterizer's resolve). */
export function leafColour(rgb, layerI, tint) {
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
  return rgb.mul(layerTint).mul(vec3(tint.mul(0.92), tint, tint.mul(0.8))).mul(inner).mul(1.2);
}

/** Bark colour before lighting. */
export const barkColour = (rgb) => rgb.mul(vec3(0.9, 0.86, 0.8));

/** Per-tree brightness variation. */
export const treeTint = (inst) => hash(inst).mul(0.35).add(0.8);

/** Screen-space dither in [0, 1) (interleaved gradient noise): a fixed pattern, so a cross-fade doesn't shimmer. */
export const ditherAt = (xy) => fract(dot(xy, vec2(0.06711056, 0.00583715)).fract().mul(52.9829189));
export const dither = () => ditherAt(screenCoordinate.xy);

// debug 4: a flat, unlit colour per tree type, in geometry and impostors alike (harness --typematch masks with it;
// keep in sync with TYPE_IDS in tools/harness/typematch.mjs): six hues 60 degrees apart, told apart by hue after
// fog and tone mapping; the dull olive ground and pale sky aren't saturated enough to count.
export const TYPE_IDS = [[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], [1, 0, 1]];
export const typeId = (type) => {
  let c = vec3(...TYPE_IDS[TYPE_IDS.length - 1]);
  for (let i = TYPE_IDS.length - 2; i >= 0; i--) c = select(uint(type).mod(TYPE_IDS.length).equal(i), vec3(...TYPE_IDS[i]), c);
  return c;
};
