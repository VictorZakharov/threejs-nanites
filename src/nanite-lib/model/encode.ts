// Writes a model file (decode.ts reads it): the mesh's vertices reordered for the vertex cache and compression,
// positions quantized to 16 bits over its box, its cluster DAG (dag/build.ts) built from the very floats the file
// decodes to, at the height it's shown at (the LOD errors are in metres), all meshopt-compressed after a JSON header.
// Plain TypeScript: tools/nanite-model.ts runs it in Node (reading the scan, writing the file), a page could too.
import { MeshoptEncoder } from 'meshoptimizer';
import { buildDag } from '../dag/build.ts';
import type { DagResult } from '../dag/types.ts';
import { dequantize, MODEL_FORMAT, type ModelHeader } from './decode.ts';
import { modelSource } from './source.ts';

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

  // quantize to 16 bits over the bounding box
  const lo = [0, 1, 2].map((k) => { let a = Infinity; for (let i = k; i < np.length; i += 3) a = Math.min(a, np[i]); return a; });
  const hi = [0, 1, 2].map((k) => { let a = -Infinity; for (let i = k; i < np.length; i += 3) a = Math.max(a, np[i]); return a; });
  const q = new Uint16Array(unique * 4);
  for (let i = 0; i < unique; i++) for (let k = 0; k < 3; k++) q[i * 4 + k] = Math.round(((np[i * 3 + k] - lo[k]) / (hi[k] - lo[k] || 1)) * 65535);
  const vb = MeshoptEncoder.encodeVertexBuffer(new Uint8Array(q.buffer), unique, 8);

  // the cluster DAG, from the very floats the file decodes to, at the height it's shown at
  const { height } = opts, attr = opts.attr ?? [1, 1];
  const src = modelSource(dequantize(q, unique, lo, hi), idx, height);
  const dag = await buildDag({ id: 0, bark: src.bark, leaves: src.leaves, barkAttr: attr });
  const clusters = dag.meta.length / 4;
  const bytes = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const ib = MeshoptEncoder.encodeIndexBuffer(bytes(dag.idx), dag.idx.length, 4);
  const rb = MeshoptEncoder.encodeVertexBuffer(bytes(dag.rec), clusters, 64);
  const mb = MeshoptEncoder.encodeVertexBuffer(bytes(dag.meta), clusters, 16);
  const header = {
    format: MODEL_FORMAT, vertices: unique, lo, hi, height, vertexBytes: vb.length, indices: dag.idx.length, indexBytes: ib.length,
    clusters, recBytes: rb.length, metaBytes: mb.length, stats: dag.stats, attr, source: opts.source ?? '',
  };
  // [header length (padded to 4)] [JSON header, padded with spaces] [positions] [DAG triangles] [records] [meta]
  const head = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - (head.length % 4)) % 4;
  const parts = [new Uint8Array(new Uint32Array([head.length + pad]).buffer), head, new Uint8Array(pad).fill(32), vb, ib, rb, mb];
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (file.set(p, o), o + p.length), 0);
  return { file, header, dag };
}
