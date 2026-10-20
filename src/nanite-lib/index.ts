// The Nanite-style renderer's library: what another three.js WebGPU project needs to draw its own meshes with cluster
// LOD. Nothing in src/nanite-lib/ imports from outside it but three and meshoptimizer (tools/check-lib.ts checks).
// Applications import it through this file; a worker imports the modules it needs directly (its bundle takes only
// what it imports).
//
//   const dag = await buildDag({ id: 0, bark: mesh, leaves: noCards });          // per mesh type, in a worker
//   const nanite = new NaniteRenderer(renderer, types, { a, b }, textures, look);  // look: gpu/look.ts's hooks
//   scene.add(nanite.group);
//   per frame: nanite.update(camera, size, time, shadowCamera); render; nanite.occlusion(...); nanite.rasterize(...);
//   render the PHASE2_LAYER (see the demo's src/webgpu-frame.ts)

// cluster DAG build for any mesh (CPU: a worker, or Node), and its cut on the CPU
export { buildDag } from './dag/build.ts';
export { LEAF_ERR } from './dag/leaves.ts';
export { dagCut, type MeshPart } from './dag/cut.ts';
export type { BarkSource, LeafSource, LeafMask, DagRequest, DagResult, DagStats } from './dag/types.ts';
export { coverageScales, maskOf, select } from './alpha.ts';

// the model file (.nm): a mesh with its DAG built offline, meshopt-compressed
export { encodeModel, type EncodeOptions, type EncodedModel } from './model/encode.ts';
export { decodeModel, readHeader, dequantize, loadModel, MODEL_FORMAT, type ModelHeader, type LoadedModel } from './model/decode.ts';
export { modelSource, type ModelSource } from './model/source.ts';

// a worker's error event as an Error naming the worker
export { workerError } from './worker-error.ts';

// the GPU-driven renderer
export { NaniteRenderer } from './gpu/renderer.ts';
export { defaultLook, type NaniteLook, type MotionInput } from './gpu/look.ts';
export type { NaniteType, NaniteInstances, NaniteTextures, NaniteUniforms, NaniteStats, Shading, View, CullSet, Counters, U } from './gpu/types.ts';
export {
  PHASE2_LAYER, SHADOW_TAU_MUL, MIN_PX, FADE_HI, MAX_TRIS, LIST_CAP, ARGS, STATS, ITEM_COUNT, RETEST, SW, IMP_ARGS, SPLAT,
  minU, minI, maxI, rotY,
} from './gpu/constants.ts';
export {
  makeLeafAlpha, makeLeafAlphaLod, a2cDither, dither, ditherAt, ditherAlt, ditherShift, mipBias, footprint, switchPx, typeId,
  TYPE_IDS, LEAF_DITHER, LEAF_COV,
} from './gpu/shading.ts';
export { GROW, GROW_SHADOW, IMP_DITHER, IMP_COV, DROP, DROP_FADE, type ImpostorGains } from './gpu/billboards.ts';
export { MAX_PIXELS } from './gpu/softraster.ts';

// impostors: the atlas (albedo + normals from 4 elevations), its bake and coverage
export {
  createAtlas, bakeImpostors, impostorCoverage, atlasLayout, IMPOSTOR_CUT, ELEVATIONS, TILE_W, TILE_H,
  type ImpostorAtlas, type BakeTextures, type AtlasCoverage,
} from './impostors/atlas.ts';

// TSL node types and the casts where @types/three lags the runtime
export type * from './types.ts';
export * from './three-gaps.ts';
