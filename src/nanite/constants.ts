// Sizes and limits shared by the forest renderer's modules (src/nanite/).
import * as THREE from 'three/webgpu';
import { vec3, storage, select, uint, clamp } from 'three/tsl';
import type { Float, Int, Uint, Vec3 } from '../types.ts';

export const MIN_PX = 2; // impostors are never drawn narrower than this (pixels)
export const FADE_HI = 1.3; // impostor cross-fade band: [1, FADE_HI] x impostorPx (geometry count unchanged)
// shadow casters may be coarser than what's seen (?shadowtau=): at 2.5 they were 9M triangles at full detail (the
// trees all round the viewer, by the camera's pixels) for a 2048 map of ~11 cm texels; at 5 half that, same image
export const SHADOW_TAU_MUL = Number(new URLSearchParams(location.search).get('shadowtau') ?? 5);
export const MAX_TRIS = 128;
export const WG = 64;
export const MAX_ITEMS = 1 << 20; // max 64-cluster work items per view (dispatched 2D: 65535 workgroups per dimension)
export const MAX_DIM = 65535;
export const LIST_CAP = 1 << 20; // max visible clusters per list
// marks an impostor in the phase 2 retest list (tree indices are below it); a tree in the cross-fade band is listed
// both as geometry and as an impostor
export const IMP_BIT = 0x80000000;
// marks a splatted impostor's id in the software rasterizer's visibility buffer (cluster ids are below 2^27)
export const SPLAT_BIT = 0x80000000;
export const HZB_LEVELS = 13;
export const HZB_LEVEL0_MAX = 2048 * 2048; // level 0 texels (half resolution): screens up to 4096 x 4096
export const HZB_FLOATS = Math.ceil(HZB_LEVEL0_MAX * 1.34) + 64;

/** min() of two uints (the TSL typings' min() takes floats and vectors only). */
export const minU = (a: Uint, b: Uint | number): Uint => {
  const bb = typeof b === 'number' ? uint(b) : b;
  return select(a.lessThan(bb), a, bb);
};

/** min() / max() of two ints (likewise). */
export const minI = (a: Int, b: Int): Int => select(a.lessThan(b), a, b);
export const maxI = (a: Int, b: Int): Int => select(a.greaterThan(b), a, b);

export const rotY = (p: Vec3, cs: Float, sn: Float): Vec3 => vec3(p.x.mul(cs).sub(p.z.mul(sn)), p.y, p.x.mul(sn).add(p.z.mul(cs)));
/**
 * How far the wind can push a tree's part (m), added to its sphere in the occlusion tests: `top` is the part's highest
 * point and `height` the tree's (local units), `s` its scale, `sway` the wind (u.wind x windOf: 0 for none). The bend of
 * _vertex (draw.ts) is at most 0.06 x 1.2 (the strongest gust) x |(0.8, -0.15, 0.6)| x height x (top / height)^2, the
 * leaves' flutter 0.04 x |(1, 0.5, -0.7)|. It was 10% of the whole tree's height + 0.5 m for every part, trunk bases
 * too: on the ground 1.5M drawn triangles were hidden but for it (`--probe=cullcheck`).
 */
export const windMargin = (height: Float, top: Float, s: Float, sway: Float): Float => {
  const h = clamp(top.div(height), 0, 1);
  return h.mul(h).mul(height).mul(0.0728).add(0.0528).mul(s).mul(sway);
};

/** Layer of the main view's phase 2 meshes (see occlusion()). */
export const PHASE2_LAYER = 2;

/** vec4s per cluster in the cluster data buffer (see NaniteForest._cd / _meta). */
export const CD_STRIDE = 5;

// Each view's small counters live in one buffer (a shader may bind only 8 storage buffers on some GPUs: Macs, for
// one). Per set (phase), SET_STRIDE uints: the bark and leaf indirect draw args (ARGS; the leaves' are indexed: 5
// uints, the last firstInstance, always 0), the stats (STATS: bark tris,
// leaf tris, trees, occluded trees, occluded impostors) and the clamped work-item count (ITEM_COUNT); then the main
// view's retest counts (RETEST: trees, clusters appended; trees, clusters clamped) and the software rasterizer's
// (SW: clusters, triangles appended; clusters clamped); last the impostor draw's indirect args (IMP_ARGS, indexed: 6
// indices, instances = the impostors listed this frame (see View.impListAttr), then 0s); then the main view's splatted
// impostors (SPLAT: listed from the top of its impostor list down, see splats.ts).
export const SET_STRIDE = 16;
export const ARGS = { bark: 0, leaf: 4 };
export const STATS = 9;
export const ITEM_COUNT = 14;
export const RETEST = 32;
export const SW = 36;
export const IMP_ARGS = 40;
export const SPLAT = 45;
export const CTR_SIZE = 46;

/**
 * A view's counters buffer, with one node per access mode: a shader must use only one of them (two bindings of the
 * same buffer count twice against the limit, and a read-only one beside a writable one is invalid). Shaders that
 * both read and add use `atomic` (atomicLoad).
 */
export function makeCounters() {
  const init = new Uint32Array(CTR_SIZE);
  for (const s of [0, SET_STRIDE]) init[s + ARGS.bark] = init[s + ARGS.leaf] = MAX_TRIS * 3; // (vertices / indices per draw instance)
  init[IMP_ARGS] = 6; // (an impostor quad: two triangles, four vertices)
  const attr = new THREE.IndirectStorageBufferAttribute(init, 1);
  return {
    attr,
    atomic: storage(attr, 'uint', CTR_SIZE).toAtomic(),
    rw: storage(attr, 'uint', CTR_SIZE),
    ro: storage(attr, 'uint', CTR_SIZE).toReadOnly(),
  };
}
