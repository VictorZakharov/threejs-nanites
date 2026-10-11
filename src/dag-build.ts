// Builds a Nanite-style cluster DAG for one mesh: a tree's bark and leaves, or any triangle mesh (a model: no leaves).
// Runs in a worker (dag-worker.ts) or in Node (tools).
//
// Bark: classic Nanite build. Triangles -> 128-tri clusters; then repeatedly: group ~8 adjacent clusters, merge,
// simplify to half (vertices shared with other groups locked, so neighbouring LODs never crack), re-split into
// clusters. Every cluster records its own LOD sphere/error and its parent group's sphere/error; at runtime a cluster
// is drawn iff its own projected error <= threshold < its parent's projected error.
//
// Leaves: dag-leaves.ts.
import { MeshoptClusterizer, MeshoptSimplifier } from 'meshoptimizer';
import type { DagRequest, DagResult } from './dag-types.ts';
import { GROUP_SIZE, mergeSpheres, mortonOrder, compact, meshletize, makeCluster } from './dag-util.ts';
import type { Cluster, LeafCluster, LeafVerts } from './dag-util.ts';
import { buildLeaves } from './dag-leaves.ts';

function groupByAdjacency(clusters: Cluster[], remap: Uint32Array): Cluster[][] {
  const n = clusters.length;
  // vertex -> clusters
  const vmap = new Map<number, number[]>();
  clusters.forEach((c, ci) => {
    const s = new Set<number>();
    for (const v of c.idx) s.add(remap[v]);
    for (const r of s) {
      let l = vmap.get(r);
      if (!l) vmap.set(r, (l = []));
      l.push(ci);
    }
  });
  const adj = clusters.map(() => new Map<number, number>());
  for (const l of vmap.values()) {
    if (l.length < 2) continue;
    for (let a = 0; a < l.length; a++)
      for (let b = a + 1; b < l.length; b++) {
        adj[l[a]].set(l[b], (adj[l[a]].get(l[b]) ?? 0) + 1);
        adj[l[b]].set(l[a], (adj[l[b]].get(l[a]) ?? 0) + 1);
      }
  }
  const order = mortonOrder(clusters.map((c) => c.cull));
  const rank = new Int32Array(n);
  order.forEach((ci, i) => (rank[ci] = i));
  const assigned = new Int32Array(n).fill(-1);
  const groups: Cluster[][] = [];
  for (const seed of order) {
    if (assigned[seed] >= 0) continue;
    const gi = groups.length;
    const group = [seed];
    assigned[seed] = gi;
    const score = new Map<number, number>();
    const addNeighbours = (c: number): void => {
      for (const [nb, w] of adj[c]) if (assigned[nb] < 0) score.set(nb, (score.get(nb) ?? 0) + w);
    };
    addNeighbours(seed);
    while (group.length < GROUP_SIZE) {
      let best = -1, bestW = 0;
      for (const [nb, w] of score) if (assigned[nb] < 0 && w > bestW) { best = nb; bestW = w; }
      if (best < 0) {
        // no connected neighbour left: take the spatially nearest unassigned cluster in the Morton window
        const g = mergeSpheres(group.map((c) => clusters[c].cull));
        let bestD = Infinity;
        const r0 = rank[seed];
        for (let k = Math.max(0, r0 - 48); k < Math.min(n, r0 + 48); k++) {
          const c = order[k];
          if (assigned[c] >= 0) continue;
          const s = clusters[c].cull;
          const d = Math.hypot(s[0] - g[0], s[1] - g[1], s[2] - g[2]);
          if (d < bestD) { bestD = d; best = c; }
        }
        // don't glue far-apart islands together: that would make huge LOD spheres
        if (best < 0 || bestD > g[3] * 3 + 1) break;
      }
      score.delete(best);
      assigned[best] = gi;
      group.push(best);
      addNeighbours(best);
    }
    groups.push(group.map((c) => clusters[c]));
  }
  return groups;
}

/** The bark simplifier's attribute weights (normal xyz, uv): their error adds to the position error (m). */
const BARK_WEIGHTS = [0.5, 0.5, 0.5, 0.08, 0.08];

function buildBark(pos: Float32Array, attr: Float32Array, idx: Uint32Array, out: Cluster[], [ns, us] = [1, 1], errMode: 'sum' | 'max' = 'max'): number {
  const weights = BARK_WEIGHTS.map((w, i) => w * (i < 3 ? ns : us));
  const nv = pos.length / 3;
  const remap = MeshoptSimplifier.generatePositionRemap(pos, 3);
  let current = meshletize(idx, pos).map((ci) => makeCluster(ci, pos, 0, 0, null));
  out.push(...current);
  let level = 0;
  const owner = new Int32Array(nv);
  const shared = new Uint8Array(nv);
  while (current.length > 1 && level < 32) {
    level++;
    const groups = groupByAdjacency(current, remap);
    owner.fill(-1);
    shared.fill(0);
    groups.forEach((g, gi) => {
      for (const c of g)
        for (const v of c.idx) {
          const r = remap[v];
          if (owner[r] === -1) owner[r] = gi;
          else if (owner[r] !== gi) shared[r] = 1;
        }
    });
    const next: Cluster[] = [];
    let progress = false;
    for (const g of groups) {
      let total = 0;
      for (const c of g) total += c.idx.length;
      const merged = new Uint32Array(total);
      let o = 0;
      for (const c of g) { merged.set(c.idx, o); o += c.idx.length; }
      const tris = total / 3;
      const { local, verts } = compact(merged);
      const lpos = new Float32Array(verts.length * 3);
      const lattr = new Float32Array(verts.length * 5);
      const lock = new Uint8Array(verts.length);
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        lpos.set(pos.subarray(v * 3, v * 3 + 3), i * 3);
        lattr.set(attr.subarray(v * 5, v * 5 + 5), i * 5);
        lock[i] = shared[remap[v]];
      }
      const target = Math.floor(tris / 2) * 3;
      const [res, err] = MeshoptSimplifier.simplifyWithAttributes(
        local, lpos, 3, lattr, 5, weights, lock, target, 1e9, ['ErrorAbsolute'],
      );
      if (res.length / 3 > tris * 0.85) {
        next.push(...g); // could not reduce enough: retry with different neighbours next level
        continue;
      }
      progress = true;
      const childMax = Math.max(...g.map((c) => c.err));
      // The group's error: the largest of its children's and its own simplification's (measured from the children's
      // mesh), as Nanite does: each switch then moves the image by at most tau. The sum (meshoptimizer's demo:
      // conservative, the drift from full detail) kept far trees' bark several levels too fine: a 30 px oak drew
      // ~2900 bark triangles (~40% of all at the user's zoomed spot), with the same popping (`--sweep=lod`).
      const gErr = errMode === 'max' ? Math.max(childMax, err, 1e-5) : childMax + Math.max(err, 1e-5);
      const gSphere = mergeSpheres(g.map((c) => c.lod));
      for (const c of g) { c.parentErr = gErr; c.parentLod = gSphere; }
      if (res.length === 0) continue; // whole group collapsed away (tiny twigs)
      const gIdx = new Uint32Array(res.length);
      for (let i = 0; i < res.length; i++) gIdx[i] = verts[res[i]];
      for (const ci of meshletize(gIdx, pos)) {
        const c = makeCluster(ci, pos, level, gErr, gSphere);
        out.push(c);
        next.push(c);
      }
    }
    current = next;
    if (!progress) break;
  }
  return level;
}

/** The DAG of one mesh (bark + leaves; `leaves.pos` empty for a plain model), packed for the renderer. */
export async function buildDag(req: DagRequest): Promise<DagResult> {
  const { id, bark, leaves, leafErr, barkAttr, barkErr } = req;
  {
    await MeshoptClusterizer.ready;
    await MeshoptSimplifier.ready;
    const t0 = performance.now();

    // bark
    const barkClusters: Cluster[] = [];
    const battr = new Float32Array((bark.pos.length / 3) * 5);
    for (let i = 0; i < bark.pos.length / 3; i++) {
      battr.set(bark.nrm.subarray(i * 3, i * 3 + 3), i * 5);
      battr.set(bark.uv.subarray(i * 2, i * 2 + 2), i * 5 + 3);
    }
    const barkLevels = buildBark(bark.pos, battr, bark.idx, barkClusters, barkAttr, barkErr);

    // leaves (vertex arrays grow as reduced leaves are appended)
    const lv: LeafVerts = { pos: Array.from(leaves.pos), nrm: Array.from(leaves.nrm), uv: Array.from(leaves.uv) };
    const leafClusters: LeafCluster[] = [];
    const leafLevels = leaves.pos.length ? buildLeaves(lv, leaves.vpl, leafClusters, leafErr) : 0;

    // ---- pack: vertex = [x y z u nx ny nz v]
    // Leaf vertices in cluster order, each cluster's own (a vertex two clusters shared would be copied: none are), so a
    // cluster's cards are contiguous quads (0 1 2, 0 2 3 from its first vertex) and the hardware draw shares one index
    // buffer between all leaf clusters (draw.ts): the GPU then reuses the two corners a card's triangles share.
    const leafSrc: number[] = []; // the source vertex of each packed leaf vertex
    const leafIdx = leafClusters.map((c) => {
      const local = new Map<number, number>();
      return Uint32Array.from(c.idx, (v) => {
        let o = local.get(v);
        if (o === undefined) local.set(v, (o = leafSrc.push(v) - 1));
        return o;
      });
    });
    const nb = bark.pos.length / 3, nl = leafSrc.length;
    const vtx = new Float32Array((nb + nl) * 8);
    const put = (i: number, p: ArrayLike<number>, pi: number, n: ArrayLike<number>, ni: number, uv: ArrayLike<number>, ui: number): void => {
      vtx[i * 8] = p[pi * 3]; vtx[i * 8 + 1] = p[pi * 3 + 1]; vtx[i * 8 + 2] = p[pi * 3 + 2]; vtx[i * 8 + 3] = uv[ui * 2];
      vtx[i * 8 + 4] = n[ni * 3]; vtx[i * 8 + 5] = n[ni * 3 + 1]; vtx[i * 8 + 6] = n[ni * 3 + 2]; vtx[i * 8 + 7] = uv[ui * 2 + 1];
    };
    for (let i = 0; i < nb; i++) put(i, bark.pos, i, bark.nrm, i, bark.uv, i);
    for (let i = 0; i < nl; i++) put(nb + i, lv.pos, leafSrc[i], lv.nrm, leafSrc[i], lv.uv, leafSrc[i]);
    leafClusters.forEach((c, i) => (c.idx = leafIdx[i]));

    const all: [Cluster, number][] = [...barkClusters.map((c): [Cluster, number] => [c, 0]), ...leafClusters.map((c): [Cluster, number] => [c, 1])];
    let totalIdx = 0;
    for (const [c] of all) totalIdx += c.idx.length;
    const idx = new Uint32Array(totalIdx);
    const rec = new Float32Array(all.length * 16);
    const meta = new Uint32Array(all.length * 4);
    let o = 0;
    all.forEach(([c, kind], i) => {
      const off = kind === 1 ? nb : 0;
      for (let k = 0; k < c.idx.length; k++) idx[o + k] = c.idx[k] + off;
      const pl = c.parentLod ?? c.lod;
      rec.set(c.lod, i * 16);
      rec.set(pl, i * 16 + 4);
      rec.set(c.cull, i * 16 + 8);
      rec[i * 16 + 12] = c.err;
      rec[i * 16 + 13] = c.parentErr;
      rec[i * 16 + 14] = c.level;
      rec[i * 16 + 15] = kind;
      meta[i * 4] = o;
      meta[i * 4 + 1] = c.idx.length / 3;
      meta[i * 4 + 2] = c.level;
      meta[i * 4 + 3] = kind;
      o += c.idx.length;
    });
    const stats = {
      barkTris: bark.idx.length / 3,
      leafTris: leaves.pos.length ? (leaves.pos.length / 3 / 4) * 2 : 0,
      barkClusters: barkClusters.length,
      leafClusters: leafClusters.length,
      barkLevels,
      leafLevels,
      barkRoots: barkClusters.filter((c) => c.parentErr >= 1e30).length,
      leafRoots: leafClusters.filter((c) => c.parentErr >= 1e30).length,
      ms: Math.round(performance.now() - t0),
    };
    return { id, vtx, idx, rec, meta, stats };
  }
}
