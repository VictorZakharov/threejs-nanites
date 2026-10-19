// The forest's GPU data (NaniteForest's methods, attached in forest.ts): every variant's vertices, triangles and
// clusters in a few merged buffers, the instances, and per type where its clusters are. A model still downloading
// (BuiltTree.later: Lucy, ~5 MB) has its share reserved, with no clusters, and is filled in when it arrives.
import * as THREE from 'three/webgpu';
import { storage, uniformArray } from 'three/tsl';
import { CD_STRIDE } from './constants.ts';
import { InstanceChunks } from './chunks.ts';
import type { NaniteForest } from './forest.ts';
import type { BuiltTree } from '../trees.ts';
import type { TreeInstances } from '../placement.ts';

/** The CPU copies of the merged buffers (a late model is written into them) and where each type's share starts. */
export interface ForestArrays {
  vtx: Float32Array;
  idx: Uint32Array;
  cData: Float32Array;
  cMeta: Uint32Array;
  /** Per type its first cluster, vertex and index (reserved for a late model). */
  at: { co: number; vo: number; io: number }[];
}

/**
 * Writes a type's clusters (sorted by parent error, descending: for a given distance the selectable ones are then a
 * prefix), triangles and vertices at the given offsets; returns its bounding radius round its axis.
 */
function pack(t: BuiltTree, a: ForestArrays, { co, vo, io }: ForestArrays['at'][number]): number {
  const n = t.meta.length / 4;
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => t.rec[y * 16 + 13] - t.rec[x * 16 + 13]);
  let radius = 0;
  const cy = t.height / 2;
  order.forEach((src, k) => {
    const r = t.rec.subarray(src * 16, src * 16 + 16);
    const o = (co + k) * CD_STRIDE * 4;
    a.cData.set(r, o);
    a.cMeta[o + 16] = t.meta[src * 4] + io;
    a.cMeta[o + 17] = t.meta[src * 4 + 1];
    a.cMeta[o + 18] = t.meta[src * 4 + 2];
    a.cMeta[o + 19] = t.meta[src * 4 + 3];
    for (const s of [r.subarray(0, 4), r.subarray(4, 8), r.subarray(8, 12)])
      radius = Math.max(radius, Math.hypot(s[0], s[1] - cy, s[2]) + s[3]);
  });
  for (let i = 0; i < t.idx.length; i++) a.idx[io + i] = t.idx[i] + vo;
  a.vtx.set(t.vtx, vo * 8);
  return radius;
}

export const bufferMethods = {
  _buildBuffers(this: NaniteForest, trees: BuiltTree[], instances: TreeInstances): void {
    let nClusters = 0, nVerts = 0, nIdx = 0;
    const at: ForestArrays['at'] = [];
    for (const t of trees) {
      at.push({ co: nClusters, vo: nVerts, io: nIdx });
      nClusters += t.later?.clusters ?? t.meta.length / 4;
      nVerts += t.later?.verts ?? t.vtx.length / 8;
      nIdx += t.later?.indices ?? t.idx.length;
    }
    // (few, merged buffers: a shader may bind only 8 storage buffers on some GPUs, Macs among them)
    // per vertex: (x y z u), (nx ny nz v); per cluster CD_STRIDE vec4s: lod sphere, parent lod sphere, cull sphere,
    // (err, parent err, level, kind), and its meta as uint bits (first index, triangles, level, kind)
    const cBuf = new ArrayBuffer(nClusters * CD_STRIDE * 16);
    const a: ForestArrays = { vtx: new Float32Array(nVerts * 8), idx: new Uint32Array(nIdx), cData: new Float32Array(cBuf), cMeta: new Uint32Array(cBuf), at };
    this.arrays = a;
    const typeInfo: THREE.Vector4[] = [];
    this.stats = { clusters: nClusters, verts: nVerts, tris: nIdx / 3, types: [] };
    trees.forEach((t, k) => {
      // (a late model: no clusters yet, so nothing of it is drawn; its radius a bound for the chunks' boxes)
      const radius = t.later ? t.radius : pack(t, a, at[k]);
      typeInfo.push(new THREE.Vector4(at[k].co, t.later ? 0 : t.meta.length / 4, radius, t.height));
      this.stats.types.push({ name: t.variant.preset, ...t.stats, radius: +radius.toFixed(1) });
    });
    const sb = (arr: Float32Array | Uint32Array, item: number) => new THREE.StorageBufferAttribute(arr, item);
    this.vtx = storage(sb(a.vtx, 4), 'vec4', nVerts * 2).toReadOnly();
    this.idx = storage(sb(a.idx, 1), 'uint', nIdx).toReadOnly();
    this.cData = storage(sb(a.cData, 4), 'vec4', nClusters * CD_STRIDE).toReadOnly();
    this.typeValues = typeInfo;
    this.typeInfo = uniformArray<'vec4'>(typeInfo, 'vec4');
    this.chunks = new InstanceChunks(instances.a, instances.b, typeInfo);
    this.instA = instances.a;
    this.instB = instances.b;
    this.impFrameValues = typeInfo.map(() => new THREE.Vector4(1e9, 0, 0, 0));
    this.impFrame = uniformArray<'vec4'>(this.impFrameValues, 'vec4');
    this.windOf = uniformArray<'float'>(trees.map((t) => (t.variant.model ? 0 : 1)), 'float');

    this.instanceCount = instances.a.length / 4;
    this.treeCount = instances.trees;
    this.statueCount = instances.statues;
    this.u.firstModel.value = this.instanceCount - this.statueCount;
    // per tree two vec4s: a = (x, y, z, scale), b = (cos, sin, type, wind phase)
    const inst = new Float32Array(this.instanceCount * 8), ia = instances.a, ib = instances.b;
    for (let i = 0, o = 0, s = 0; i < this.instanceCount; i++, o += 8, s += 4) {
      inst[o] = ia[s]; inst[o + 1] = ia[s + 1]; inst[o + 2] = ia[s + 2]; inst[o + 3] = ia[s + 3];
      inst[o + 4] = ib[s]; inst[o + 5] = ib[s + 1]; inst[o + 6] = ib[s + 2]; inst[o + 7] = ib[s + 3];
    }
    this.inst = storage(sb(inst, 4), 'vec4', this.instanceCount * 2).toReadOnly();
  },

  /** Fills in a late model (BuiltTree.later) once it's arrived: its share of the buffers, then its clusters. */
  fillType(this: NaniteForest, t: BuiltTree): void {
    const a = this.arrays, at = a.at[t.id], ti = this.typeValues[t.id];
    const n = t.meta.length / 4, nv = t.vtx.length / 8, ni = t.idx.length;
    const next = a.at[t.id + 1] ?? { co: a.cData.length / (CD_STRIDE * 4), vo: a.vtx.length / 8, io: a.idx.length };
    if (at.co + n > next.co || at.vo + nv > next.vo || at.io + ni > next.io) throw new Error(`${t.variant.preset}: bigger than its header said`);
    const radius = pack(t, a, at);
    const upload = (node: { value: THREE.BufferAttribute }, start: number, count: number): void => {
      node.value.addUpdateRange(start, count);
      node.value.needsUpdate = true;
    };
    upload(this.vtx, at.vo * 8, nv * 8);
    upload(this.idx, at.io, ni);
    upload(this.cData, at.co * CD_STRIDE * 4, n * CD_STRIDE * 4);
    ti.set(at.co, n, radius, t.height);
    // (its LOD spheres reach further than its mesh's box: Lucy's 8.4 m to 2.4; the chunks' boxes grow to match)
    const types = this.typeValues, b = this.instB;
    let first = this.instanceCount;
    for (let i = 0; i < this.instanceCount; i++) if (b[i * 4 + 2] === t.id) { first = i; break; }
    this.chunks.refit(this.instA, b, types, first);
    const st = this.stats.types[t.id];
    if (st) st.radius = +radius.toFixed(1);
  },
};
