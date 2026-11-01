// Loads a model file written by encode.ts (tools/nanite-model.ts makes the demo's, public/models/*.nm): a JSON
// header, the positions quantized to `bits` (14), then the cluster DAG built offline (its triangles per cluster, the
// clusters' spheres in 16 bits and errors, and meta), all meshopt-compressed. The DAG's vertices are the model's own, so normals and uvs are
// rebuilt here (source.ts) and nothing is built at load: one file for every device (the 3 s DAG build at load was why
// phones had a smaller copy).
import { MeshoptDecoder } from 'meshoptimizer';
import { modelSource, type ModelSource } from './source.ts';
import type { DagResult, DagStats } from '../dag/types.ts';
import { workerError } from '../worker-error.ts';

/** The file format's tag (encode.ts writes it, readHeader checks it). 2: 16-bit positions, the records as floats. */
export const MODEL_FORMAT = 'nanite-model 3';
const READS = [MODEL_FORMAT, 'nanite-model 2']; // (2 for `npm run model -- X.nm --reencode`)

export interface ModelHeader {
  format: string;
  vertices: number;
  lo: number[];
  hi: number[];
  height: number; // m: the height the DAG was built at (its spheres and errors)
  vertexBytes: number;
  indices: number;
  indexBytes: number;
  clusters: number;
  recBytes: number;
  metaBytes: number;
  stats: DagStats;
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

/**
 * The file's header and its blocks: positions (4 x 16 bits a vertex, `head.bits` of them used), the DAG's triangles,
 * the records (16 floats a cluster, rebuilt from format 3's 16-bit spheres, errors and meta), meta.
 */
export async function readBlocks(buf: Uint8Array): Promise<{ head: ModelHeader; q: Uint16Array; idx: Uint32Array; rec: Float32Array; meta: Uint32Array }> {
  const head = readHeader(buf);
  if (!head) throw new Error('model file cut short');
  const headLen = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
  await MeshoptDecoder.ready;
  let o = 4 + headLen;
  const take = (n: number) => buf.subarray(o, (o += n));
  const q = new Uint16Array(head.vertices * 4);
  MeshoptDecoder.decodeVertexBuffer(new Uint8Array(q.buffer), head.vertices, 8, take(head.vertexBytes));
  const idx = new Uint32Array(head.indices);
  MeshoptDecoder.decodeIndexBuffer(new Uint8Array(idx.buffer), head.indices, 4, take(head.indexBytes));
  const rec = new Float32Array(head.clusters * 16);
  if (head.format === 'nanite-model 2') {
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(rec.buffer), head.clusters, 64, take(head.recBytes));
    head.bits = 16;
  } else {
    // spheres: LOD, parent LOD, culling, each centre and radius in 16 bits; errors: own and parent's, as floats
    const s = new Uint16Array(head.clusters * 12), e = new Float32Array(head.clusters * 2);
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(s.buffer), head.clusters, 24, take(head.recBytes));
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(e.buffer), head.clusters, 8, take(head.errBytes!));
    const lo = head.sphereLo!, hi = head.sphereHi!, rmax = head.radius!;
    for (let c = 0; c < head.clusters; c++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) rec[c * 16 + j * 4 + k] = lo[k] + (s[c * 12 + j * 4 + k] / 65535) * (hi[k] - lo[k]);
        rec[c * 16 + j * 4 + 3] = (s[c * 12 + j * 4 + 3] / 65535) * rmax;
      }
      rec[c * 16 + 12] = e[c * 2];
      rec[c * 16 + 13] = e[c * 2 + 1];
    }
  }
  const meta = new Uint32Array(head.clusters * 4);
  MeshoptDecoder.decodeVertexBuffer(new Uint8Array(meta.buffer), head.clusters, 16, take(head.metaBytes));
  if (head.format !== 'nanite-model 2') for (let c = 0; c < head.clusters; c++) (rec[c * 16 + 14] = meta[c * 4 + 2]), (rec[c * 16 + 15] = meta[c * 4 + 3]); // (level, kind)
  return { head, q, idx, rec, meta };
}

/** The file's DAG and source mesh, at `height` m. */
export async function decodeModel(buf: Uint8Array, height: number): Promise<{ dag: Omit<DagResult, 'id'>; src: ModelSource }> {
  const { head, q, idx, rec, meta } = await readBlocks(buf);

  // the full-detail mesh: the level-0 clusters' triangles (normals, the impostor bake's frame)
  let n0 = 0;
  for (let c = 0; c < head.clusters; c++) if (meta[c * 4 + 2] === 0 && meta[c * 4 + 3] === 0) n0 += meta[c * 4 + 1] * 3;
  const base = new Uint32Array(n0);
  for (let c = 0, b = 0; c < head.clusters; c++)
    if (meta[c * 4 + 2] === 0 && meta[c * 4 + 3] === 0) {
      base.set(idx.subarray(meta[c * 4], meta[c * 4] + meta[c * 4 + 1] * 3), b);
      b += meta[c * 4 + 1] * 3;
    }
  const src = modelSource(dequantize(q, head.vertices, head.lo, head.hi, head.bits), base, height);

  // spheres and errors scale with the height (exactly only at the built height: the uvs' share of the error doesn't)
  const s = height / head.height;
  if (s !== 1) {
    console.warn(`model built at ${head.height} m, shown at ${height} m: rebuild it with --height=${height} for exact LOD errors`);
    for (let c = 0; c < head.clusters; c++) for (let k = 0; k < 14; k++) rec[c * 16 + k] *= s;
  }
  const { pos, nrm, uv } = src.bark;
  const vtx = new Float32Array(head.vertices * 8);
  for (let i = 0; i < head.vertices; i++) {
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
 * as the file's header has arrived, `model` once it's all decoded.
 */
export function loadModel(url: string, height: number): { header: Promise<ModelHeader>; model: Promise<LoadedModel> } {
  let gotHeader: (h: ModelHeader) => void = () => {}, fail: (e: Error) => void = () => {};
  const header = new Promise<ModelHeader>((resolve, reject) => ((gotHeader = resolve), (fail = reject)));
  const model = new Promise<LoadedModel>((resolve, reject) => {
    const w = new Worker(new URL('./model-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<LoadedModel | { header: ModelHeader } | { error: string }>) => {
      if ('header' in e.data) return gotHeader(e.data.header);
      w.terminate();
      if ('error' in e.data) {
        const err = new Error(e.data.error);
        fail(err);
        reject(err);
      } else resolve(e.data);
    };
    w.onerror = (e) => {
      const err = workerError(`model-worker (${url})`, e);
      fail(err);
      reject(err);
    };
    w.postMessage({ url: new URL(url, document.baseURI).href, height });
  });
  return { header, model };
}
