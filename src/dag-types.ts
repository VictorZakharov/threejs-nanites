// What the main thread sends the DAG worker (src/dag-worker.ts) and what comes back.

/** Bark mesh of one tree, in metres: positions, normals, uvs (2 per vertex), triangles. */
export interface BarkSource {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  idx: Uint32Array;
}

/** Leaf cards of one tree: `vpl` vertices per leaf (4, or 8 for crossed double cards), quads in order. */
export interface LeafSource {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  vpl: number;
}

export interface DagRequest {
  id: number;
  bark: BarkSource;
  leaves: LeafSource;
  /** A coarser leaf level's error, as a share of its (grown) leaf size (dag-leaves.ts; ?leaferr=). */
  leafErr?: number;
}

export interface DagStats {
  barkTris: number;
  leafTris: number;
  barkClusters: number;
  leafClusters: number;
  barkLevels: number;
  leafLevels: number;
  barkRoots: number;
  leafRoots: number;
  ms: number;
}

/**
 * The packed DAG: `vtx` 8 floats per vertex (x y z u nx ny nz v); `idx` triangles of every cluster, back to back;
 * `rec` 16 floats per cluster (LOD sphere, parent LOD sphere, culling sphere, error, parent error, level, kind 0 bark
 * / 1 leaf); `meta` 4 uints per cluster (first index, triangles, level, kind).
 */
export interface DagResult {
  id: number;
  vtx: Float32Array;
  idx: Uint32Array;
  rec: Float32Array;
  meta: Uint32Array;
  stats: DagStats;
}

export type DagReply = DagResult | { id: number; error: string };
