// Sizes and limits shared by the forest renderer's modules (src/nanite/).
import * as THREE from 'three/webgpu';
import { vec3, storage } from 'three/tsl';
import type { Float, Vec3 } from '../types.ts';

export const MIN_PX = 2; // impostors are never drawn narrower than this (pixels)
export const FADE_HI = 1.3; // impostor cross-fade band: [1, FADE_HI] x impostorPx (geometry count unchanged)
export const SHADOW_TAU_MUL = 2.5; // shadow casters may be coarser than what's seen
export const MAX_TRIS = 128;
export const WG = 64;
export const MAX_ITEMS = 1 << 20; // max 64-cluster work items per view (dispatched 2D: 65535 workgroups per dimension)
export const MAX_DIM = 65535;
export const LIST_CAP = 1 << 20; // max visible clusters per list
// marks an impostor in the phase 2 retest list (tree indices are below it); a tree in the cross-fade band is listed
// both as geometry and as an impostor
export const IMP_BIT = 0x80000000;
export const HZB_LEVELS = 13;
export const HZB_LEVEL0_MAX = 2048 * 2048; // level 0 texels (half resolution): screens up to 4096 x 4096
export const HZB_FLOATS = Math.ceil(HZB_LEVEL0_MAX * 1.34) + 64;

export const rotY = (p: Vec3, cs: Float, sn: Float): Vec3 => vec3(p.x.mul(cs).sub(p.z.mul(sn)), p.y, p.x.mul(sn).add(p.z.mul(cs)));
/** How far wind can push a tree's parts (m), for a tree this tall: added to spheres in the occlusion tests. */
export const windMargin = (height: Float): Float => height.mul(0.1).add(0.5);

/** Layer of the main view's phase 2 meshes (see occlusion()). */
export const PHASE2_LAYER = 2;

/** vec4s per cluster in the cluster data buffer (see NaniteForest._cd / _meta). */
export const CD_STRIDE = 5;

// Each view's small counters live in one buffer (a shader may bind only 8 storage buffers on some GPUs: Macs, for
// one). Per set (phase), SET_STRIDE uints: the bark and leaf indirect draw args (ARGS), the stats (STATS: bark tris,
// leaf tris, trees, occluded trees, occluded impostors) and the clamped work-item count (ITEM_COUNT); then the main
// view's retest counts (RETEST: trees, clusters appended; trees, clusters clamped) and the software rasterizer's
// (SW: clusters, triangles appended; clusters clamped).
export const SET_STRIDE = 16;
export const ARGS = { bark: 0, leaf: 4 };
export const STATS = 8;
export const ITEM_COUNT = 13;
export const RETEST = 32;
export const SW = 36;
export const CTR_SIZE = 40;

/**
 * A view's counters buffer, with one node per access mode: a shader must use only one of them (two bindings of the
 * same buffer count twice against the limit, and a read-only one beside a writable one is invalid). Shaders that
 * both read and add use `atomic` (atomicLoad).
 */
export function makeCounters() {
  const init = new Uint32Array(CTR_SIZE);
  for (const s of [0, SET_STRIDE]) init[s + ARGS.bark] = init[s + ARGS.leaf] = MAX_TRIS * 3; // (vertices per draw instance)
  const attr = new THREE.IndirectStorageBufferAttribute(init, 1);
  return {
    attr,
    atomic: storage(attr, 'uint', CTR_SIZE).toAtomic(),
    rw: storage(attr, 'uint', CTR_SIZE),
    ro: storage(attr, 'uint', CTR_SIZE).toReadOnly(),
  };
}
