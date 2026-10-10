// Loads a model file written by tools/nanite-model.mjs (public/models/*.nm): a JSON header, positions quantized to
// 16 bits and meshopt-compressed, indices meshopt-compressed. Returns it as a Nanite variant's source, at `height` m.
import { MeshoptDecoder } from 'meshoptimizer';
import { modelSource, type ModelSource } from './model-source.ts';

interface ModelHeader {
  format: string;
  vertices: number;
  indices: number;
  lo: number[];
  hi: number[];
  vertexBytes: number;
  indexBytes: number;
}

export async function loadModel(url: string, height: number): Promise<ModelSource> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const headLen = new DataView(buf.buffer).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + headLen))) as ModelHeader;
  await MeshoptDecoder.ready;
  const vOff = 4 + headLen, iOff = vOff + head.vertexBytes;
  const q = new Uint16Array(head.vertices * 4);
  MeshoptDecoder.decodeVertexBuffer(new Uint8Array(q.buffer), head.vertices, 8, buf.subarray(vOff, iOff));
  const idx = new Uint32Array(head.indices);
  MeshoptDecoder.decodeIndexBuffer(new Uint8Array(idx.buffer), head.indices, 4, buf.subarray(iOff, iOff + head.indexBytes));
  const pos = new Float32Array(head.vertices * 3);
  for (let i = 0; i < head.vertices; i++)
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = head.lo[k] + (q[i * 4 + k] / 65535) * (head.hi[k] - head.lo[k]);
  return modelSource(pos, idx, height);
}
