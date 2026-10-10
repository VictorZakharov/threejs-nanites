// Sizes and limits shared by the forest renderer's modules (src/nanite/).
import { vec3 } from 'three/tsl';

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

export const rotY = (p, cs, sn) => vec3(p.x.mul(cs).sub(p.z.mul(sn)), p.y, p.x.mul(sn).add(p.z.mul(cs)));
/** How far wind can push a tree's parts (m), for a tree this tall: added to spheres in the occlusion tests. */
export const windMargin = (height) => height.mul(0.1).add(0.5);

/** Layer of the main view's phase 2 meshes (see occlusion()). */
export const PHASE2_LAYER = 2;
