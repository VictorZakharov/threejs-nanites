// The Nanite-style renderer's library: what another three.js project needs to draw its own meshes with cluster LOD.
// Nothing in src/nanite-lib/ imports from outside it but three and meshoptimizer (tools/check-lib.ts checks). The
// demo imports the library through this file; a worker imports the modules it needs directly (its bundle takes only
// what it imports). Issue #17 has the plan: the GPU renderer (src/nanite/) and the impostors move in next.

// cluster DAG build for any mesh (CPU: a worker, or Node)
export { buildDag } from './dag/build.ts';
export { LEAF_ERR } from './dag/leaves.ts';
export type { BarkSource, LeafSource, LeafMask, DagRequest, DagResult, DagStats } from './dag/types.ts';

// the model file (.nm): a mesh with its DAG built offline, meshopt-compressed
export { encodeModel, type EncodeOptions, type EncodedModel } from './model/encode.ts';
export { decodeModel, readHeader, dequantize, loadModel, MODEL_FORMAT, type ModelHeader, type LoadedModel } from './model/decode.ts';
export { modelSource, type ModelSource } from './model/source.ts';

// a worker's error event as an Error naming the worker
export { workerError } from './worker-error.ts';
