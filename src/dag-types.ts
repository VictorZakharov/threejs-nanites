// What the main thread sends the DAG worker (src/dag-worker.ts) and what comes back.
import type { TreeSource, TreeVariant } from './trees.ts';

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
  /** The leaf texture's alpha (dag-coverage.ts): coarser levels cover what the finer did (none: area kept; ?leafcover=0). */
  leafMask?: LeafMask;
  /** Scales of the bark simplifier's normal and uv weights (dag-build.ts BARK_WEIGHTS; ?barkattr=n,uv). */
  barkAttr?: [number, number];
  /** How a bark group's error adds to its children's: the max (default: each switch moves <= tau) or the sum (?barkerr=sum). */
  barkErr?: 'sum' | 'max';
}

/**
 * What the worker is sent: a mesh, or a variant to grow first (tree-grow.ts; its meshes come back as `src`), then
 * its leaf mask (or null) in a message of its own.
 */
export type DagJob = DagRequest | (Omit<DagRequest, 'bark' | 'leaves'> & { grow: TreeVariant });

/** A leaf texture's alpha as a coarse mask: `size` x `size`, 1 = opaque, rows from the image's top. */
export interface LeafMask {
  size: number;
  bits: Uint8Array;
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
  /** Each leaf level's mean growth of the kept cards (sqrt(2): area kept). */
  leafGrowth: number[];
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
  /** With `grow`: the tree's source meshes and how long growing it took (ms). */
  src?: TreeSource;
  growMs?: number;
}

export type DagReply = DagResult | { id: number; error: string };
