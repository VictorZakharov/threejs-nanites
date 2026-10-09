// Builds a Nanite-style cluster DAG for one tree (bark + leaves), off the main thread.
//
// Bark: classic Nanite build. Triangles -> 128-tri clusters; then repeatedly: group ~8 adjacent clusters, merge,
// simplify to half (vertices shared with other groups locked, so neighbouring LODs never crack), re-split into
// clusters. Every cluster records its own LOD sphere/error and its parent group's sphere/error; at runtime a cluster
// is drawn iff its own projected error <= threshold < its parent's projected error.
//
// Leaves: disconnected alpha-tested cards cannot be simplified by edge collapse, so a group of leaf clusters is
// reduced by keeping half the leaves and growing each kept leaf by sqrt(2) (area preserving) - same DAG, same
// runtime selection.
import { MeshoptClusterizer, MeshoptSimplifier } from 'meshoptimizer';

const MAX_TRIS = 128;
const MAX_VERTS = 128;
const GROUP_SIZE = 8;
const LEAF_GROUP_SIZE = 4;

// ---------------------------------------------------------------- math helpers
function sphereOfPoints(pos, verts) {
  // centroid + max distance (good enough, cheap)
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) {
    cx += pos[v * 3];
    cy += pos[v * 3 + 1];
    cz += pos[v * 3 + 2];
  }
  const n = verts.size ?? verts.length;
  cx /= n; cy /= n; cz /= n;
  let r = 0;
  for (const v of verts) {
    const dx = pos[v * 3] - cx, dy = pos[v * 3 + 1] - cy, dz = pos[v * 3 + 2] - cz;
    r = Math.max(r, dx * dx + dy * dy + dz * dz);
  }
  return [cx, cy, cz, Math.sqrt(r)];
}

function mergeSpheres(spheres) {
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

function morton3(x, y, z) {
  const part = (v) => {
    v = Math.min(1023, Math.max(0, v | 0));
    v = (v | (v << 16)) & 0x030000ff;
    v = (v | (v << 8)) & 0x0300f00f;
    v = (v | (v << 4)) & 0x030c30c3;
    v = (v | (v << 2)) & 0x09249249;
    return v;
  };
  return (part(x) | (part(y) << 1) | (part(z) << 2)) >>> 0;
}

function mortonOrder(points /* [x,y,z][] */) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-6);
  const codes = points.map((p) => morton3(((p[0] - mn[0]) / ext) * 1023, ((p[1] - mn[1]) / ext) * 1023, ((p[2] - mn[2]) / ext) * 1023));
  return points.map((_, i) => i).sort((a, b) => codes[a] - codes[b]);
}

/** Compacts a global index list into a local mesh. */
function compact(globalIdx) {
  const map = new Map();
  const verts = [];
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
function meshletize(globalIdx, pos) {
  const { local, verts } = compact(globalIdx);
  const lpos = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    lpos[i * 3] = pos[verts[i] * 3];
    lpos[i * 3 + 1] = pos[verts[i] * 3 + 1];
    lpos[i * 3 + 2] = pos[verts[i] * 3 + 2];
  }
  const buffers = MeshoptClusterizer.buildMeshlets(local, lpos, 3, MAX_VERTS, MAX_TRIS, 0.0);
  const out = [];
  for (let m = 0; m < buffers.meshletCount; m++) {
    const { vertices, triangles } = MeshoptClusterizer.extractMeshlet(buffers, m);
    const idx = new Uint32Array(triangles.length);
    for (let i = 0; i < triangles.length; i++) idx[i] = verts[vertices[triangles[i]]];
    out.push(idx);
  }
  return out;
}

function makeCluster(idx, pos, level, err, lodSphere) {
  const cull = sphereOfPoints(pos, new Set(idx));
  return { idx, level, err, lod: lodSphere ?? cull, cull, parentErr: 1e30, parentLod: null };
}

// ---------------------------------------------------------------- bark
function groupByAdjacency(clusters, remap) {
  const n = clusters.length;
  // vertex -> clusters
  const vmap = new Map();
  clusters.forEach((c, ci) => {
    const s = new Set();
    for (const v of c.idx) s.add(remap[v]);
    for (const r of s) {
      let l = vmap.get(r);
      if (!l) vmap.set(r, (l = []));
      l.push(ci);
    }
  });
  const adj = clusters.map(() => new Map());
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
  const groups = [];
  for (const seed of order) {
    if (assigned[seed] >= 0) continue;
    const gi = groups.length;
    const group = [seed];
    assigned[seed] = gi;
    const score = new Map();
    const addNeighbours = (c) => {
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

function buildBark(pos, attr, idx, out) {
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
    const next = [];
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
        local, lpos, 3, lattr, 5, [0.5, 0.5, 0.5, 0.08, 0.08], lock, target, 1e9, ['ErrorAbsolute'],
      );
      if (res.length / 3 > tris * 0.85) {
        next.push(...g); // could not reduce enough: retry with different neighbours next level
        continue;
      }
      progress = true;
      const childMax = Math.max(...g.map((c) => c.err));
      const gErr = childMax + Math.max(err, 1e-5);
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

// ---------------------------------------------------------------- leaves
function buildLeaves(lv, vpl, out) {
  // lv: growable vertex store { pos: number[], nrm: number[], uv: number[] }
  const leafCount = lv.pos.length / 3 / vpl;
  const quadsPerLeaf = vpl / 4;
  const leavesPerCluster = Math.floor(MAX_TRIS / (quadsPerLeaf * 2));
  const leaves = []; // { first: vertex, base: [x,y,z] }
  const P = lv.pos;
  for (let i = 0; i < leafCount; i++) {
    const f = i * vpl;
    // base = midpoint of the bottom edge (verts 1 and 2 of the first quad)
    const base = [0, 1, 2].map((k) => (P[(f + 1) * 3 + k] + P[(f + 2) * 3 + k]) / 2);
    const size = Math.hypot(P[(f + 2) * 3] - P[(f + 1) * 3], P[(f + 2) * 3 + 1] - P[(f + 1) * 3 + 1], P[(f + 2) * 3 + 2] - P[(f + 1) * 3 + 2]);
    leaves.push({ first: f, base, size });
  }
  const leafIdx = (leaf) => {
    const r = [];
    for (let q = 0; q < quadsPerLeaf; q++) {
      const i = leaf.first + q * 4;
      r.push(i, i + 1, i + 2, i, i + 2, i + 3);
    }
    return r;
  };
  const posArr = () => P; // live array (grows)
  const clusterFrom = (ls, level, err, lod) => {
    const idx = new Uint32Array(ls.flatMap(leafIdx));
    const verts = new Set(idx);
    const cull = sphereOfPoints(posArr(), verts);
    return { idx, leaves: ls, level, err, lod: lod ?? cull, cull, parentErr: 1e30, parentLod: null };
  };
  const chunk = (ls, level, err, lod) => {
    const order = mortonOrder(ls.map((l) => l.base));
    const sorted = order.map((i) => ls[i]);
    const res = [];
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
    const next = [];
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
      const kept = [];
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
      const gErr = Math.max(childMax * 1.05 + 1e-4, avgSize * 0.35);
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

// ---------------------------------------------------------------- entry
self.onmessage = async (e) => {
  const { id, bark, leaves } = e.data;
  try {
    await MeshoptClusterizer.ready;
    await MeshoptSimplifier.ready;
    const t0 = performance.now();

    // bark
    const barkClusters = [];
    const battr = new Float32Array((bark.pos.length / 3) * 5);
    for (let i = 0; i < bark.pos.length / 3; i++) {
      battr.set(bark.nrm.subarray(i * 3, i * 3 + 3), i * 5);
      battr.set(bark.uv.subarray(i * 2, i * 2 + 2), i * 5 + 3);
    }
    const barkLevels = buildBark(bark.pos, battr, bark.idx, barkClusters);

    // leaves (vertex arrays grow as reduced leaves are appended)
    const lv = { pos: Array.from(leaves.pos), nrm: Array.from(leaves.nrm), uv: Array.from(leaves.uv) };
    const leafClusters = [];
    const leafLevels = leaves.pos.length ? buildLeaves(lv, leaves.vpl, leafClusters) : 0;

    // ---- pack: vertex = [x y z u nx ny nz v]
    const nb = bark.pos.length / 3, nl = lv.pos.length / 3;
    const vtx = new Float32Array((nb + nl) * 8);
    const put = (i, p, pi, n, ni, uv, ui) => {
      vtx[i * 8] = p[pi * 3]; vtx[i * 8 + 1] = p[pi * 3 + 1]; vtx[i * 8 + 2] = p[pi * 3 + 2]; vtx[i * 8 + 3] = uv[ui * 2];
      vtx[i * 8 + 4] = n[ni * 3]; vtx[i * 8 + 5] = n[ni * 3 + 1]; vtx[i * 8 + 6] = n[ni * 3 + 2]; vtx[i * 8 + 7] = uv[ui * 2 + 1];
    };
    for (let i = 0; i < nb; i++) put(i, bark.pos, i, bark.nrm, i, bark.uv, i);
    for (let i = 0; i < nl; i++) put(nb + i, lv.pos, i, lv.nrm, i, lv.uv, i);

    const all = [...barkClusters.map((c) => [c, 0]), ...leafClusters.map((c) => [c, 1])];
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
    self.postMessage({ id, vtx, idx, rec, meta, stats }, [vtx.buffer, idx.buffer, rec.buffer, meta.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack ?? err) });
  }
};
