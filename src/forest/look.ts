// The forest's look in the Nanite renderer (src/nanite-lib/gpu/look.ts's hooks): the planet's curve, the wind, the
// trees' tints and autumn, the leaf textures' tints, and the impostors' colour turned the same way. The WebGL mode's
// near trees (src/webgl/near.ts) share the colours.
import * as THREE from 'three/webgpu';
import { uniform, uniformArray, uint, float, vec3, select, hash, clamp, sin, dot, max, smoothstep, normalLocal } from 'three/tsl';
import type { UniformArrayNode, UniformNode } from 'three/webgpu';
import type { NaniteLook, NaniteTextures, NaniteUniforms } from '../nanite-lib/index.ts';
import { curve, viewerPos, PLANET_RADIUS } from '../planet.ts';
import { autumnOf, autumnColour } from '../autumn.ts';
import type { Float, Uint, Vec3 } from '../types.ts';

/** The forest's uniforms: the renderer's, and the wind (0: off; the grass sways with it too). */
export type ForestUniforms = NaniteUniforms & { wind: UniformNode<'float', number> };

/** Leaf colour before lighting (the hardware draw, the software rasterizer's resolve, the WebGL mode's); `autumn`: the
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

/** The leaves' colour baked into the impostor atlas: the leaf colour without the per-tree tint (applied at runtime). */
export function bakeCardColour(rgb: Vec3, layer: number): Vec3 {
  // (a uniform: every tree's materials compile to the same shaders, see bakeImpostors)
  const layerTint = uniform(layer === 2 ? new THREE.Vector3(0.5, 0.82, 0.85) : layer === 3 ? new THREE.Vector3(0.62, 0.78, 1.0) : new THREE.Vector3(1, 1, 1));
  const inner = smoothstep(-0.6, 0.8, normalLocal.y).mul(0.4).add(0.6);
  return rgb.mul(layerTint).mul(inner).mul(1.2);
}

/** What the impostor bake takes of the look (the WebGL mode bakes without a NaniteForest). */
export const forestBakeLook = { solidColour: barkColour, bakeCardColour };

/**
 * How far the wind can push a tree's part (m), added to its sphere in the occlusion tests: `top` is the part's highest
 * point and `height` the tree's (local units), `s` its scale, `sway` the wind (u.wind x windOf: 0 for none). The bend of
 * the motion below is at most 0.06 x 1.2 (the strongest gust) x |(0.8, -0.15, 0.6)| x height x (top / height)^2, the
 * leaves' flutter 0.04 x |(1, 0.5, -0.7)|. It was 10% of the whole tree's height + 0.5 m for every part, trunk bases
 * too: on the ground 1.5M drawn triangles were hidden but for it (`--probe=cullcheck`).
 */
export const windMargin = (height: Float, top: Float, s: Float, sway: Float): Float => {
  const h = clamp(top.div(height), 0, 1);
  return h.mul(h).mul(height).mul(0.0728).add(0.0528).mul(s).mul(sway);
};

/**
 * The forest's hooks. `wind`: the wind's strength (u.wind); `windOf`: per type 1, or 0 for models (statues don't
 * sway); `textures`: for the pines' layer (their needles and impostors stay green in autumn).
 */
export function forestLook(wind: UniformNode<'float', number>, windOf: UniformArrayNode<'float'>, textures: NaniteTextures): NaniteLook {
  const sway = (type: Uint): Float => wind.mul(windOf.element(type));
  return {
    curve,
    curveRadius: PLANET_RADIUS,
    viewer: viewerPos.value,
    // wind: whole tree bends with height^2, leaves flutter on top
    motion: ({ local, height, a, b, type, card }) => {
      const s = a.w;
      const h = clamp(local.y.div(height), 0, 1);
      return (time) => {
        const t = time.mul(1.1).add(b.w);
        const gust = sin(t.add(a.x.mul(0.013))).mul(0.6).add(sin(t.mul(2.7).add(a.z.mul(0.021))).mul(0.25)).add(0.35);
        const sw = sway(type); // (0 for models)
        const bend = h.mul(h).mul(gust).mul(sw).mul(0.06).mul(height).mul(s);
        let off: Vec3 = vec3(bend.mul(0.8), bend.mul(-0.15), bend.mul(0.6));
        if (card !== false) {
          const ph = dot(local, vec3(1.7, 2.3, 1.1));
          const fl = sin(time.mul(7.0).add(ph)).mul(0.04).mul(sw).mul(s);
          const flutter = vec3(fl, fl.mul(0.5), fl.mul(-0.7));
          off = off.add(card === true ? flutter : select(card, flutter, vec3(0)));
        }
        return off;
      };
    },
    motionOutput: 'wind', // (the scene target's second output: the TAA's wind motion vectors)
    motionMargin: (height, top, s, type) => windMargin(height, top, s, sway(uint(type))),
    tint: treeTint,
    cardValue: (_inst, b) => autumnOf(b.w),
    impostorValue: (_inst, b, type) => select(textures.leafLayerOf(type).equal(3), float(0), autumnOf(b.w)), // (pines stay green)
    solidColour: barkColour,
    cardColour: leafColour,
    impostorColour: (albedo, gain, tint, value) => {
      // (autumn on the leaf texels only: the atlas has bark too, and leaves are the green ones)
      const green = albedo.mul(vec3(tint.mul(0.92), tint, tint.mul(0.8))).mul(gain);
      return autumnColour(green, value, smoothstep(0, 0.03, green.g.sub(max(green.r, green.b))));
    },
    bakeCardColour,
  };
}

/** The wind's strength and which types sway (1, models 0), for forestLook. */
export function forestWind(isModel: boolean[]): { wind: UniformNode<'float', number>; windOf: UniformArrayNode<'float'> } {
  return { wind: uniform(1), windOf: uniformArray<'float'>(isModel.map((m) => (m ? 0 : 1)), 'float') };
}
