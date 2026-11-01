// Writes a model file (decode.ts reads it): the mesh's vertices reordered for the vertex cache and compression,
// positions quantized to BITS over its box, its cluster DAG (dag/build.ts) built from the very floats the file
// decodes to, at the height it's shown at (the LOD errors are in metres), all meshopt-compressed after a JSON header.
// Plain TypeScript: tools/nanite-model.ts runs it in Node (reading the scan, writing the file), a page could too.
import { MeshoptEncoder } from 'meshoptimizer';
import { buildDag } from '../dag/build.ts';
import type { DagResult } from '../dag/types.ts';
import { dequantize, readBlocks, MODEL_FORMAT, type ModelHeader, type ModelPart } from './decode.ts';
import { modelSource } from './source.ts';

/**
 * The positions' bits (#62). 16 was finer than the scan: Lucy's 4M triangles have edges ~40 steps long, and what the
 * codecs can't predict is that noise (parallelogram prediction over the triangles left 5-7 bits a coordinate: 0.5 MB
 * at best). At 14 the edges are ~10 steps whatever the statue's scale (both scale with it), a 3x statue's face from
 * 3 m looks the same (`lucyface`, `lucyfoot`), and Lucy's 4M file is ~1.4 MB smaller gzipped.
 */
const BITS = 14;

/**
 * The coarse copy's share of the triangles (#63): its levels are the coarsest that hold at most this. Lucy 4M's are
 * levels 6-16, 128k triangles, 0.44 MB of 16.1 gzipped (+2.8%): there in ~0.4 s on a 10 Mb/s line, the rest in ~13. Ordering the
 * whole file coarse levels first instead (each level's vertices numbered as it first uses them) made it ~50% bigger:
 * the finer levels' triangles jumped back to the coarse levels' vertices, and the index codec stores the jumps.
 */
const COARSE_SHARE = 1 / 32;

export interface EncodeOptions {
  /** Metres: the height the DAG is built at (the model is shown at it; another height scales the errors, inexactly). */
  height: number;
  /** The bark simplifier's normal and uv weights x these (dag/build.ts BARK_WEIGHTS): heavier normals switch later. */
  attr?: [number, number];
  /** Where the mesh came from (kept in the header). */
  source?: string;
}

export interface EncodedModel {
  file: Uint8Array;
  header: ModelHeader & { attr: [number, number]; source: string };
  /** The DAG as built (decodeModel's should match it: positions and uvs exactly). */
  dag: DagResult;
}

/** `pos`: the model at height 1, base at y = 0, centred on its axis; `idx`: its triangles (renumbered in place). */
export async function encodeModel(pos: Float32Array, idx: Uint32Array, opts: EncodeOptions): Promise<EncodedModel> {
  await MeshoptEncoder.ready;
  // drop unused vertices, order for the vertex cache and compression
  const [remap, unique] = MeshoptEncoder.reorderMesh(idx, true, false);
  const np = new Float32Array(unique * 3);
  for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) np.set(pos.subarray(i * 3, i * 3 + 3), remap[i] * 3);

  // quantize to BITS over the bounding box
  const lo = [0, 1, 2].map((k) => { let a = Infinity; for (let i = k; i < np.length; i += 3) a = Math.min(a, np[i]); return a; });
  const hi = [0, 1, 2].map((k) => { let a = -Infinity; for (let i = k; i < np.length; i += 3) a = Math.max(a, np[i]); return a; });
  const q = new Uint16Array(unique * 4), top = 2 ** BITS - 1;
  for (let i = 0; i < unique; i++) for (let k = 0; k < 3; k++) q[i * 4 + k] = Math.round(((np[i * 3 + k] - lo[k]) / (hi[k] - lo[k] || 1)) * top);

  // the cluster DAG, from the very floats the file decodes to, at the height it's shown at
  const { height } = opts, attr = opts.attr ?? [1, 1];
  const src = modelSource(dequantize(q, unique, lo, hi, BITS), idx, height);
  const dag = await buildDag({ id: 0, bark: src.bark, leaves: src.leaves, barkAttr: attr });
  firstUse(q, dag.idx, unique, dag.vtx);
  const header = { format: MODEL_FORMAT, vertices: unique, lo, hi, bits: BITS, height, stats: dag.stats, attr, source: opts.source ?? '' };
  const { file, sizes } = write(header, q, dag.idx, dag.rec, dag.meta, (v) => dag.vtx.subarray(v * 8 + 4, v * 8 + 7));
  return { file, header: { ...header, ...sizes }, dag };
}

/**
 * Renumbers the vertices in the order the DAG's triangles first use them (cluster by cluster, full detail first): in
 * reorderMesh's order the coarser levels' triangles jumped across the whole vertex range, and the index codec stores
 * those jumps (Lucy's 4M file 25.2 -> 23.0 MB, its triangles 16.3 -> 14.1; 19.4 -> 17.7 gzipped). In place: `q` (4 x
 * 16-bit slots a vertex), `idx`, and the DAG's `vtx` (8 floats a vertex) if given.
 */
function firstUse(q: Uint16Array, idx: Uint32Array, n: number, vtx?: Float32Array): void {
  const remap = new Uint32Array(n).fill(0xffffffff);
  let next = 0;
  for (let i = 0; i < idx.length; i++) {
    let r = remap[idx[i]];
    if (r === 0xffffffff) r = remap[idx[i]] = next++;
    idx[i] = r;
  }
  if (next !== n) throw new Error(`${n - next} vertices no triangle uses`);
  const q0 = q.slice(), v0 = vtx?.slice();
  for (let v = 0; v < n; v++) {
    q.set(q0.subarray(v * 4, v * 4 + 4), remap[v] * 4);
    if (vtx && v0) vtx.set(v0.subarray(v * 8, v * 8 + 8), remap[v] * 8);
  }
}

/**
 * The file: [header length (padded to 4)] [JSON header, padded with spaces] [the coarse copy: positions, normals, DAG
 * triangles, spheres, errors, meta] [the model: positions, DAG triangles, spheres, errors, meta]. The spheres (LOD,
 * parent LOD, culling) in 16 bits over their own box, each grown by its centre's rounding and `pad` (m) and rounded
 * up: never smaller than the one it stands for, so culling stays conservative, and a cluster's parent sphere is still
 * its parent's own (the same floats in, the same out). 1.57 -> ~0.9 MB gzipped. Levels and kinds are in meta.
 * `normal`: a vertex's unit normal (the coarse copy stores its own: without the full detail it can't rebuild them).
 */
function write(base: Record<string, unknown> & { vertices: number }, q: Uint16Array, idx: Uint32Array, rec: Float32Array, meta: Uint32Array, normal: (v: number) => ArrayLike<number>, pad = 0): { file: Uint8Array; sizes: ModelPart & Pick<ModelHeader, 'sphereLo' | 'sphereHi' | 'radius' | 'coarse'> } {
  const clusters = meta.length / 4;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let r0 = 0;
  for (let c = 0; c < clusters; c++)
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], rec[c * 16 + j * 4 + k])), (hi[k] = Math.max(hi[k], rec[c * 16 + j * 4 + k]));
      r0 = Math.max(r0, rec[c * 16 + j * 4 + 3]);
    }
  const step = Math.hypot(...[0, 1, 2].map((k) => (hi[k] - lo[k]) / 65535)), radius = (r0 + pad + step) * 1.0001;
  const box = { lo, hi, radius, pad };
  const full = blocks(q, idx, rec, meta, box);
  const c = coarseOf(q, idx, rec, meta, normal);
  const coarse = c && blocks(c.q, c.idx, c.rec, c.meta, box, c.oct);
  const sizes = { ...full.sizes, sphereLo: lo, sphereHi: hi, radius, ...(coarse ? { coarse: { ...coarse.sizes, level: c.level } } : {}) };
  const head = new TextEncoder().encode(JSON.stringify({ ...base, format: MODEL_FORMAT, ...sizes }));
  const hpad = (4 - (head.length % 4)) % 4;
  const parts = [new Uint8Array(new Uint32Array([head.length + hpad]).buffer), head, new Uint8Array(hpad).fill(32), ...(coarse?.parts ?? []), ...full.parts];
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (file.set(p, o), o + p.length), 0);
  return { file, sizes };
}

/** One part's blocks, compressed, and their sizes (decode.ts's ModelPart). */
function blocks(q: Uint16Array, idx: Uint32Array, rec: Float32Array, meta: Uint32Array, box: { lo: number[]; hi: number[]; radius: number; pad: number }, oct?: Int16Array): { parts: Uint8Array[]; sizes: ModelPart } {
  const bytes = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const { lo, hi, radius, pad } = box, clusters = meta.length / 4, vertices = q.length / 4;
  const s = new Uint16Array(clusters * 12), e = new Float32Array(clusters * 2);
  for (let c = 0; c < clusters; c++) {
    for (let j = 0; j < 3; j++) {
      const at = c * 16 + j * 4;
      let d2 = 0;
      for (let k = 0; k < 3; k++) {
        const t = Math.round(((rec[at + k] - lo[k]) / (hi[k] - lo[k] || 1)) * 65535);
        s[c * 12 + j * 4 + k] = t;
        d2 += (lo[k] + (t / 65535) * (hi[k] - lo[k]) - rec[at + k]) ** 2;
      }
      s[c * 12 + j * 4 + 3] = Math.min(65535, Math.ceil(((rec[at + 3] + pad + Math.sqrt(d2)) / radius) * 65535));
    }
    (e[c * 2] = rec[c * 16 + 12]), (e[c * 2 + 1] = rec[c * 16 + 13]);
  }
  const vb = MeshoptEncoder.encodeVertexBuffer(bytes(q), vertices, 8);
  const nb = oct ? MeshoptEncoder.encodeVertexBuffer(bytes(oct), vertices, 4) : new Uint8Array(0);
  const ib = MeshoptEncoder.encodeIndexBuffer(bytes(idx), idx.length, 4);
  const rb = MeshoptEncoder.encodeVertexBuffer(bytes(s), clusters, 24);
  const eb = MeshoptEncoder.encodeVertexBuffer(bytes(e), clusters, 8);
  const mb = MeshoptEncoder.encodeVertexBuffer(bytes(meta), clusters, 16);
  const sizes: ModelPart = { vertices, vertexBytes: vb.length, indices: idx.length, indexBytes: ib.length, clusters, recBytes: rb.length, errBytes: eb.length, metaBytes: mb.length };
  if (oct) sizes.normalBytes = nb.length;
  return { parts: [vb, nb, ib, rb, eb, mb], sizes };
}

/**
 * The coarse copy: the clusters of the coarsest levels holding at most COARSE_SHARE of the triangles, in their order,
 * their vertices numbered as they first use them, with octahedral normals; null if that's every level.
 */
function coarseOf(q: Uint16Array, idx: Uint32Array, rec: Float32Array, meta: Uint32Array, normal: (v: number) => ArrayLike<number>) {
  const n = meta.length / 4, per: number[] = [];
  for (let c = 0; c < n; c++) per[meta[c * 4 + 2]] = (per[meta[c * 4 + 2]] ?? 0) + meta[c * 4 + 1];
  let level = per.length, sum = 0;
  while (level > 0 && sum + (per[level - 1] ?? 0) <= (COARSE_SHARE * idx.length) / 3) sum += per[--level] ?? 0;
  if (level === 0 || level === per.length) return null;
  const cs = [...Array(n).keys()].filter((c) => meta[c * 4 + 2] >= level);
  const remap = new Map<number, number>(), cidx = new Uint32Array(sum * 3), cmeta = new Uint32Array(cs.length * 4), crec = new Float32Array(cs.length * 16);
  let o = 0;
  cs.forEach((c, k) => {
    cmeta.set(meta.subarray(c * 4, c * 4 + 4), k * 4);
    cmeta[k * 4] = o;
    crec.set(rec.subarray(c * 16, c * 16 + 16), k * 16);
    for (let i = meta[c * 4]; i < meta[c * 4] + meta[c * 4 + 1] * 3; i++) {
      let r = remap.get(idx[i]);
      if (r === undefined) remap.set(idx[i], (r = remap.size));
      cidx[o++] = r;
    }
  });
  const cq = new Uint16Array(remap.size * 4), oct = new Int16Array(remap.size * 2);
  for (const [v, r] of remap) {
    cq.set(q.subarray(v * 4, v * 4 + 4), r * 4);
    const [x, y] = toOct(normal(v));
    (oct[r * 2] = x), (oct[r * 2 + 1] = y);
  }
  return { level, q: cq, idx: cidx, rec: crec, meta: cmeta, oct };
}

/** A unit normal as two snorm16s (octahedral: decode.ts fromOct). */
function toOct(n: ArrayLike<number>): [number, number] {
  const l = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) || 1;
  let u = n[0] / l, v = n[1] / l;
  if (n[2] < 0) [u, v] = [(1 - Math.abs(v)) * Math.sign(u || 1), (1 - Math.abs(u)) * Math.sign(v || 1)];
  return [Math.round(u * 32767), Math.round(v * 32767)];
}

/**
 * A built file rewritten in the current format (positions to BITS, records packed, vertices in first-use order, the
 * coarse copy), without the scan or a DAG rebuild. Its spheres grow by how far the requantized positions moved (`pad`).
 */
export async function reencodeModel(buf: Uint8Array): Promise<Uint8Array> {
  await MeshoptEncoder.ready;
  const { head, q, idx, rec, meta } = await readBlocks(buf);
  firstUse(q, idx, head.vertices);
  const from = 2 ** (head.bits ?? 16) - 1, top = 2 ** BITS - 1;
  for (let i = 0; i < q.length; i++) if (i % 4 < 3) q[i] = Math.round((q[i] / from) * top);
  // (a vertex moves at most half a new step each way: model units at height 1, the records are at head.height)
  const pad = from === top ? 0 : (head.height * Math.hypot(...[0, 1, 2].map((k) => (head.hi[k] - head.lo[k]) / top))) / 2;
  // the normals as the site rebuilds them: over the full detail's triangles (decode.ts toModel)
  const base: number[] = [];
  for (let c = 0; c < meta.length / 4; c++) if (meta[c * 4 + 2] === 0 && meta[c * 4 + 3] === 0) for (let i = meta[c * 4]; i < meta[c * 4] + meta[c * 4 + 1] * 3; i++) base.push(idx[i]);
  const { nrm } = modelSource(dequantize(q, head.vertices, head.lo, head.hi, BITS), Uint32Array.from(base), head.height).bark;
  const { vertexBytes, indices, indexBytes, clusters, recBytes, metaBytes, errBytes, sphereLo, sphereHi, radius, coarse, ...rest } = head;
  void [vertexBytes, indices, indexBytes, clusters, recBytes, metaBytes, errBytes, sphereLo, sphereHi, radius, coarse];
  return write({ ...rest, bits: BITS }, q, idx, rec, meta, (v) => nrm.subarray(v * 3, v * 3 + 3), pad).file;
}
