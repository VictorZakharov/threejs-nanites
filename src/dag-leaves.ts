// The leaf cards' cluster DAG (see dag-build.ts): disconnected alpha-tested cards cannot be simplified by edge
// collapse, so a group of leaf clusters is reduced by keeping half the leaves and growing each kept leaf by sqrt(2)
// (area preserving) - same DAG, same runtime selection.
import { MAX_TRIS, LEAF_GROUP_SIZE, sphereOfPoints, mergeSpheres, mortonOrder } from './dag-util.ts';
import type { Leaf, LeafCluster, LeafVerts, Sphere } from './dag-util.ts';

// A coarser level's error: this share of its (grown) leaf size. At 0.35 the leaves were kept under ~3 px at tau 1,
// crowns many leaves deep: several triangles per pixel (the user's 4070 Ti at 80 fps on High); at 0.175 under ~6 px,
// a quarter of the leaf triangles far off, the same image (`d550`: a few crown edges thinner).
export const LEAF_ERR = 0.175;

/** `leafErr`: a coarser level's error as a share of its leaf size (see gErr). */
export function buildLeaves(lv: LeafVerts, vpl: number, out: LeafCluster[], leafErr = LEAF_ERR): number {
  const leafCount = lv.pos.length / 3 / vpl;
  const quadsPerLeaf = vpl / 4;
  const leavesPerCluster = Math.floor(MAX_TRIS / (quadsPerLeaf * 2));
  const leaves: Leaf[] = [];
  const P = lv.pos;
  for (let i = 0; i < leafCount; i++) {
    const f = i * vpl;
    // base = midpoint of the bottom edge (verts 1 and 2 of the first quad)
    const base = [0, 1, 2].map((k) => (P[(f + 1) * 3 + k] + P[(f + 2) * 3 + k]) / 2);
    const size = Math.hypot(P[(f + 2) * 3] - P[(f + 1) * 3], P[(f + 2) * 3 + 1] - P[(f + 1) * 3 + 1], P[(f + 2) * 3 + 2] - P[(f + 1) * 3 + 2]);
    leaves.push({ first: f, base, size });
  }
  const leafIdx = (leaf: Leaf): number[] => {
    const r: number[] = [];
    for (let q = 0; q < quadsPerLeaf; q++) {
      const i = leaf.first + q * 4;
      r.push(i, i + 1, i + 2, i, i + 2, i + 3);
    }
    return r;
  };
  const posArr = () => P; // live array (grows)
  const clusterFrom = (ls: Leaf[], level: number, err: number, lod: Sphere | null): LeafCluster => {
    const idx = new Uint32Array(ls.flatMap(leafIdx));
    const verts = new Set(idx);
    const cull = sphereOfPoints(posArr(), verts);
    return { idx, leaves: ls, level, err, lod: lod ?? cull, cull, parentErr: 1e30, parentLod: null };
  };
  const chunk = (ls: Leaf[], level: number, err: number, lod: Sphere | null): LeafCluster[] => {
    const order = mortonOrder(ls.map((l) => l.base));
    const sorted = order.map((i) => ls[i]);
    const res: LeafCluster[] = [];
    // balanced chunks
    const nChunks = Math.ceil(sorted.length / leavesPerCluster);
    for (let c = 0; c < nChunks; c++) {
      const a = Math.floor((c * sorted.length) / nChunks), b = Math.floor(((c + 1) * sorted.length) / nChunks);
      res.push(clusterFrom(sorted.slice(a, b), level, err, lod));
    }
    return res;
  };

  let current = chunk(leaves, 0, 0, null);
  out.push(...current);
  let level = 0;
  while (current.length > 1 && level < 32) {
    level++;
    const order = mortonOrder(current.map((c) => c.cull));
    const next: LeafCluster[] = [];
    for (let g0 = 0; g0 < order.length; g0 += LEAF_GROUP_SIZE) {
      const g = order.slice(g0, g0 + LEAF_GROUP_SIZE).map((i) => current[i]);
      if (g.length === 1 && order.length > 1) {
        next.push(g[0]);
        continue;
      }
      const ls = g.flatMap((c) => c.leaves);
      // keep every other leaf (in Morton order, so the survivors stay spread out)
      const lorder = mortonOrder(ls.map((l) => l.base));
      const keepN = Math.max(1, Math.ceil(ls.length / 2));
      const scale = Math.sqrt(ls.length / keepN);
      const kept: Leaf[] = [];
      for (let k = 0; k < keepN; k++) {
        const src = ls[lorder[Math.floor((k * ls.length) / keepN)]];
        const first = P.length / 3;
        // grow around the card's centre: growing from the stem base pushed coarse crowns outward (bigger, brighter)
        const ctr = [0, 1, 2].map((a) => {
          let c = 0;
          for (let v = 0; v < vpl; v++) c += P[(src.first + v) * 3 + a];
          return c / vpl;
        });
        for (let v = 0; v < vpl; v++) {
          const s = src.first + v;
          for (let a = 0; a < 3; a++) P.push(ctr[a] + (P[s * 3 + a] - ctr[a]) * scale);
          lv.nrm.push(lv.nrm[s * 3], lv.nrm[s * 3 + 1], lv.nrm[s * 3 + 2]);
          lv.uv.push(lv.uv[s * 2], lv.uv[s * 2 + 1]);
        }
        kept.push({ first, base: src.base, size: src.size * scale });
      }
      const avgSize = kept.reduce((s, l) => s + l.size, 0) / kept.length;
      const childMax = Math.max(...g.map((c) => c.err));
      const gErr = Math.max(childMax * 1.05 + 1e-4, avgSize * leafErr);
      const gSphere = mergeSpheres(g.map((c) => c.lod).concat(g.map((c) => c.cull)));
      for (const c of g) { c.parentErr = gErr; c.parentLod = gSphere; }
      for (const c of chunk(kept, level, gErr, gSphere)) {
        out.push(c);
        next.push(c);
      }
    }
    current = next;
  }
  return level;
}

