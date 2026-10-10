// Shared pieces of the cluster DAG builder (dag-build.ts, dag-leaves.ts): types, bounding spheres, Morton order,
// splitting a triangle list into clusters.
import { MeshoptClusterizer } from 'meshoptimizer';

/** Bounding sphere: centre x, y, z and radius. */
export type Sphere = [number, number, number, number];
export type Point = ArrayLike<number>;
export interface Cluster {
  idx: Uint32Array;
  level: number;
  err: number;
  lod: Sphere;
  cull: Sphere;
  parentErr: number;
  parentLod: Sphere | null;
}
/** A leaf card: its first vertex, the base of its stem, its size. */
export interface Leaf {
  first: number;
  base: number[];
  size: number;
}
export interface LeafCluster extends Cluster {
  leaves: Leaf[];
}
/** The leaves' vertex store: grows as reduced (grown) leaves are appended. */
export interface LeafVerts {
  pos: number[];
  nrm: number[];
  uv: number[];
}

export const MAX_TRIS = 128;
export const MAX_VERTS = 128;
export const GROUP_SIZE = 8;
export const LEAF_GROUP_SIZE = 4;

// ---------------------------------------------------------------- math helpers
export function sphereOfPoints(pos: ArrayLike<number>, verts: Set<number>): Sphere {
  // centroid + max distance (good enough, cheap)
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) {
    cx += pos[v * 3];
    cy += pos[v * 3 + 1];
    cz += pos[v * 3 + 2];
  }
  const n = verts.size;
  cx /= n; cy /= n; cz /= n;
  let r = 0;
  for (const v of verts) {
    const dx = pos[v * 3] - cx, dy = pos[v * 3 + 1] - cy, dz = pos[v * 3 + 2] - cz;
    r = Math.max(r, dx * dx + dy * dy + dz * dz);
  }
  return [cx, cy, cz, Math.sqrt(r)];
}

export function mergeSpheres(spheres: Sphere[]): Sphere {
  // centre = radius-weighted average, radius = max(dist + r)
  let cx = 0, cy = 0, cz = 0, w = 0;
  for (const s of spheres) {
    const k = s[3] + 1e-6;
    cx += s[0] * k; cy += s[1] * k; cz += s[2] * k; w += k;
  }
  cx /= w; cy /= w; cz /= w;
  let r = 0;
  for (const s of spheres) r = Math.max(r, Math.hypot(s[0] - cx, s[1] - cy, s[2] - cz) + s[3]);
  return [cx, cy, cz, r];
}

function morton3(x: number, y: number, z: number): number {
  const part = (v: number): number => {
    v = Math.min(1023, Math.max(0, v | 0));
    v = (v | (v << 16)) & 0x030000ff;
    v = (v | (v << 8)) & 0x0300f00f;
    v = (v | (v << 4)) & 0x030c30c3;
    v = (v | (v << 2)) & 0x09249249;
    return v;
  };
  return (part(x) | (part(y) << 1) | (part(z) << 2)) >>> 0;
}

export function mortonOrder(points: Point[]): number[] {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-6);
  const codes = points.map((p) => morton3(((p[0] - mn[0]) / ext) * 1023, ((p[1] - mn[1]) / ext) * 1023, ((p[2] - mn[2]) / ext) * 1023));
  return points.map((_, i) => i).sort((a, b) => codes[a] - codes[b]);
}

/** Compacts a global index list into a local mesh. */
export function compact(globalIdx: ArrayLike<number>): { local: Uint32Array; verts: number[] } {
  const map = new Map<number, number>();
  const verts: number[] = [];
  const local = new Uint32Array(globalIdx.length);
  for (let i = 0; i < globalIdx.length; i++) {
    const g = globalIdx[i];
    let l = map.get(g);
    if (l === undefined) {
      l = verts.length;
      map.set(g, l);
      verts.push(g);
    }
    local[i] = l;
  }
  return { local, verts };
}

/** Splits a global triangle list into <=128-triangle clusters; returns arrays of global indices. */
export function meshletize(globalIdx: Uint32Array, pos: Float32Array): Uint32Array[] {
  const { local, verts } = compact(globalIdx);
  const lpos = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    lpos[i * 3] = pos[verts[i] * 3];
    lpos[i * 3 + 1] = pos[verts[i] * 3 + 1];
    lpos[i * 3 + 2] = pos[verts[i] * 3 + 2];
  }
  const buffers = MeshoptClusterizer.buildMeshlets(local, lpos, 3, MAX_VERTS, MAX_TRIS, 0.0);
  const out: Uint32Array[] = [];
  for (let m = 0; m < buffers.meshletCount; m++) {
    const { vertices, triangles } = MeshoptClusterizer.extractMeshlet(buffers, m);
    const idx = new Uint32Array(triangles.length);
    for (let i = 0; i < triangles.length; i++) idx[i] = verts[vertices[triangles[i]]];
    out.push(idx);
  }
  return out;
}

export function makeCluster(idx: Uint32Array, pos: Float32Array, level: number, err: number, lodSphere: Sphere | null): Cluster {
  const cull = sphereOfPoints(pos, new Set(idx));
  return { idx, level, err, lod: lodSphere ?? cull, cull, parentErr: 1e30, parentLod: null };
}

