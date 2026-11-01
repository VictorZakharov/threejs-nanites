// Loads a model file written by encode.ts (tools/nanite-model.ts makes the demo's, public/models/*.nm): a JSON
// header, the positions quantized to `bits` (14), then the cluster DAG built offline (its triangles per cluster, the
// clusters' spheres in 16 bits and errors, and meta), all meshopt-compressed. The DAG's vertices are the model's own, so normals and uvs are
// rebuilt here (source.ts) and nothing is built at load: one file for every device (the 3 s DAG build at load was why
// phones had a smaller copy). Format 4 starts with a coarse copy (#63): its coarsest levels, ~1/32 of the triangles,
// with their normals, drawn while the rest downloads (decodeCoarse).
import { MeshoptDecoder } from 'meshoptimizer';
import { modelSource, type ModelSource } from './source.ts';
import type { DagResult, DagStats } from '../dag/types.ts';
import { workerError } from '../worker-error.ts';

/**
 * The file format's tag (encode.ts writes it, readHeader checks it). 2: 16-bit positions, the records as floats; 3:
 * no coarse copy.
 */
export const MODEL_FORMAT = 'nanite-model 4';
const READS = [MODEL_FORMAT, 'nanite-model 3', 'nanite-model 2']; // (2 and 3 for `npm run model -- X.nm --reencode`)

/** A run of blocks: the whole model, or format 4's coarse copy (its own vertex numbering, and normals). */
export interface ModelPart {
  vertices: number;
  vertexBytes: number;
  indices: number;
  indexBytes: number;
  clusters: number;
  recBytes: number;
  errBytes?: number;
  metaBytes: number;
  /** The coarse copy: its finest level (drawn whatever the error: its finer clusters aren't in it), its normals. */
  level?: number;
  normalBytes?: number;
}

export interface ModelHeader extends ModelPart {
  format: string;
  lo: number[];
  hi: number[];
  height: number; // m: the height the DAG was built at (its spheres and errors)
  stats: DagStats;
  /** Format 4: the coarse copy, stored first. */
  coarse?: ModelPart;
  /** Format 3: the positions' bits; the spheres' box (centres) and largest radius, their 16-bit range; the errors' bytes. */
  bits?: number;
  sphereLo?: number[];
  sphereHi?: number[];
  radius?: number;
  errBytes?: number;
}

/** Positions at height 1 from their quantization to `bits` (the tool builds the DAG from these very floats). */
export function dequantize(q: Uint16Array, n: number, lo: number[], hi: number[], bits = 16): Float32Array {
  const pos = new Float32Array(n * 3), top = 2 ** bits - 1;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = lo[k] + (q[i * 4 + k] / top) * (hi[k] - lo[k]);
  return pos;
}

/** The file's header, once `buf` (its start) holds it; null before. */
export function readHeader(buf: Uint8Array): ModelHeader | null {
  if (buf.length < 4) return null;
  const headLen = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
  if (buf.length < 4 + headLen) return null;
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + headLen))) as ModelHeader;
  if (!READS.includes(head.format)) throw new Error(`model format "${head.format}": re-encode it (encode.ts)`);
  return head;
}

const partBytes = (p: ModelPart): number => p.vertexBytes + (p.normalBytes ?? 0) + p.indexBytes + p.recBytes + (p.errBytes ?? 0) + p.metaBytes;
const headBytes = (buf: Uint8Array): number => 4 + new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);

/** Where the coarse copy ends in the file (the worker decodes it once that much has arrived); 0 without one. */
export function coarseEnd(buf: Uint8Array, head: ModelHeader): number {
  return head.coarse ? headBytes(buf) + partBytes(head.coarse) : 0;
}

/** The blocks as stored: positions (4 x 16 bits a vertex, `head.bits` used), triangles, records (16 floats), meta. */
export interface ModelBlocks {
  head: ModelHeader;
  q: Uint16Array;
  idx: Uint32Array;
  rec: Float32Array;
  meta: Uint32Array;
  /** The coarse copy's normals (2 x 16-bit octahedral a vertex). */
  oct?: Int16Array;
}

/** The whole model's blocks (past format 4's coarse copy). */
export async function readBlocks(buf: Uint8Array): Promise<ModelBlocks> {
  const head = readHeader(buf);
  if (!head) throw new Error('model file cut short');
  return readPart(buf, head, head, headBytes(buf) + (head.coarse ? partBytes(head.coarse) : 0));
}

async function readPart(buf: Uint8Array, head: ModelHeader, p: ModelPart, at: number): Promise<ModelBlocks> {
  await MeshoptDecoder.ready;
  let o = at;
  const take = (n: number) => buf.subarray(o, (o += n));
  const q = new Uint16Array(p.vertices * 4);
  MeshoptDecoder.decodeVertexBuffer(new Uint8Array(q.buffer), p.vertices, 8, take(p.vertexBytes));
  let oct: Int16Array | undefined;
  if (p.normalBytes) {
    oct = new Int16Array(p.vertices * 2);
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(oct.buffer), p.vertices, 4, take(p.normalBytes));
  }
  const idx = new Uint32Array(p.indices);
  MeshoptDecoder.decodeIndexBuffer(new Uint8Array(idx.buffer), p.indices, 4, take(p.indexBytes));
  const rec = new Float32Array(p.clusters * 16);
  if (head.format === 'nanite-model 2') {
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(rec.buffer), p.clusters, 64, take(p.recBytes));
    head.bits = 16;
  } else {
    // spheres: LOD, parent LOD, culling, each centre and radius in 16 bits; errors: own and parent's, as floats
    const s = new Uint16Array(p.clusters * 12), e = new Float32Array(p.clusters * 2);
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(s.buffer), p.clusters, 24, take(p.recBytes));
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(e.buffer), p.clusters, 8, take(p.errBytes!));
    const lo = head.sphereLo!, hi = head.sphereHi!, rmax = head.radius!;
    for (let c = 0; c < p.clusters; c++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) rec[c * 16 + j * 4 + k] = lo[k] + (s[c * 12 + j * 4 + k] / 65535) * (hi[k] - lo[k]);
        rec[c * 16 + j * 4 + 3] = (s[c * 12 + j * 4 + 3] / 65535) * rmax;
      }
      rec[c * 16 + 12] = e[c * 2];
      rec[c * 16 + 13] = e[c * 2 + 1];
    }
  }
  const meta = new Uint32Array(p.clusters * 4);
  MeshoptDecoder.decodeVertexBuffer(new Uint8Array(meta.buffer), p.clusters, 16, take(p.metaBytes));
  if (head.format !== 'nanite-model 2') for (let c = 0; c < p.clusters; c++) (rec[c * 16 + 14] = meta[c * 4 + 2]), (rec[c * 16 + 15] = meta[c * 4 + 3]); // (level, kind)
  return { head, q, idx, rec, meta, oct };
}

/** The file's DAG and source mesh, at `height` m. */
export async function decodeModel(buf: Uint8Array, height: number): Promise<LoadedModel> {
  return toModel(await readBlocks(buf), height, 0);
}

/**
 * Format 4's coarse copy as a model of its own (null without one): its finest level's errors are 0, so the cut draws
 * it however near (its finer clusters aren't there), and its normals are the full model's.
 */
export async function decodeCoarse(buf: Uint8Array, height: number): Promise<LoadedModel | null> {
  const head = readHeader(buf);
  if (!head?.coarse) return null;
  const b = await readPart(buf, head, head.coarse, headBytes(buf));
  const finest = head.coarse.level!;
  for (let c = 0; c < head.coarse.clusters; c++) if (b.meta[c * 4 + 2] === finest) b.rec[c * 16 + 12] = 0;
  return toModel(b, height, finest);
}

/** Octahedral normal (two snorm16s) to a unit vector. */
export function fromOct(x: number, y: number): [number, number, number] {
  let u = x / 32767, v = y / 32767;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) [u, v] = [(1 - Math.abs(v)) * Math.sign(u || 1), (1 - Math.abs(u)) * Math.sign(v || 1)];
  const l = Math.hypot(u, v, z);
  return [u / l, v / l, z / l];
}

/** The blocks as a model: `base`, the level the source mesh is (the full detail, or the coarse copy's finest). */
function toModel({ head, q, idx, rec, meta, oct }: ModelBlocks, height: number, base: number): LoadedModel {
  const nv = q.length / 4, nc = meta.length / 4;
  // the source mesh: the base level's triangles (normals, the impostor bake's frame)
  let n0 = 0;
  for (let c = 0; c < nc; c++) if (meta[c * 4 + 2] === base && meta[c * 4 + 3] === 0) n0 += meta[c * 4 + 1] * 3;
  const tris = new Uint32Array(n0);
  for (let c = 0, b = 0; c < nc; c++)
    if (meta[c * 4 + 2] === base && meta[c * 4 + 3] === 0) {
      tris.set(idx.subarray(meta[c * 4], meta[c * 4] + meta[c * 4 + 1] * 3), b);
      b += meta[c * 4 + 1] * 3;
    }
  const src = modelSource(dequantize(q, nv, head.lo, head.hi, head.bits), tris, height);
  if (oct) for (let i = 0; i < nv; i++) src.bark.nrm.set(fromOct(oct[i * 2], oct[i * 2 + 1]), i * 3);

  // spheres and errors scale with the height (exactly only at the built height: the uvs' share of the error doesn't)
  const s = height / head.height;
  if (s !== 1) {
    console.warn(`model built at ${head.height} m, shown at ${height} m: rebuild it with --height=${height} for exact LOD errors`);
    for (let c = 0; c < nc; c++) for (let k = 0; k < 14; k++) rec[c * 16 + k] *= s;
  }
  const { pos, nrm, uv } = src.bark;
  const vtx = new Float32Array(nv * 8);
  for (let i = 0; i < nv; i++) {
    const v = i * 8;
    vtx[v] = pos[i * 3]; vtx[v + 1] = pos[i * 3 + 1]; vtx[v + 2] = pos[i * 3 + 2]; vtx[v + 3] = uv[i * 2];
    vtx[v + 4] = nrm[i * 3]; vtx[v + 5] = nrm[i * 3 + 1]; vtx[v + 6] = nrm[i * 3 + 2]; vtx[v + 7] = uv[i * 2 + 1];
  }
  return { dag: { vtx, idx, rec, meta, stats: { ...head.stats, ms: 0 } }, src };
}

/** A model's DAG and source mesh, as loadModel gives them. */
export type LoadedModel = { dag: Omit<DagResult, 'id'>; src: ModelSource };

/**
 * Downloads and decodes a model in a worker (model-worker.ts); `url` relative to the page. `header` resolves as soon
 * as the file's header has arrived, `coarse` with its coarse copy (or the model, a file without one), `model` once
 * it's all decoded.
 */
export function loadModel(url: string, height: number): { header: Promise<ModelHeader>; coarse: Promise<LoadedModel>; model: Promise<LoadedModel> } {
  let gotHeader: (h: ModelHeader) => void = () => {}, gotCoarse: (m: LoadedModel) => void = () => {}, fail: (e: Error) => void = () => {};
  const header = new Promise<ModelHeader>((resolve, reject) => ((gotHeader = resolve), (fail = reject)));
  const coarse = new Promise<LoadedModel>((resolve, reject) => {
    gotCoarse = resolve;
    const f = fail;
    fail = (e) => (f(e), reject(e));
  });
  const model = new Promise<LoadedModel>((resolve, reject) => {
    const w = new Worker(new URL('./model-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<LoadedModel | { coarse: LoadedModel } | { header: ModelHeader } | { error: string }>) => {
      if ('header' in e.data) return gotHeader(e.data.header);
      if ('coarse' in e.data) return gotCoarse(e.data.coarse);
      w.terminate();
      if ('error' in e.data) {
        const err = new Error(e.data.error);
        fail(err);
        reject(err);
      } else gotCoarse(e.data), resolve(e.data);
    };
    w.onerror = (e) => {
      const err = workerError(`model-worker (${url})`, e);
      fail(err);
      reject(err);
    };
    w.postMessage({ url: new URL(url, document.baseURI).href, height });
  });
  return { header, coarse, model };
}
