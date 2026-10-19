// Downloads and decodes a model file (models.ts) off the main thread: Lucy's meshopt decode and rebuilt normals took
// ~0.5 s of the main thread while loading (~1.5 s at a phone's speed).
import { decodeModel } from './models.ts';

self.onmessage = async (e: MessageEvent<{ url: string; height: number }>) => {
  const post = (msg: unknown, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    const res = await fetch(e.data.url);
    if (!res.ok) throw new Error(`${e.data.url}: ${res.status}`);
    const m = await decodeModel(new Uint8Array(await res.arrayBuffer()), e.data.height);
    const { vtx, idx, rec, meta } = m.dag, b = m.src.bark;
    post(m, [...new Set([vtx.buffer, idx.buffer, rec.buffer, meta.buffer, b.pos.buffer, b.nrm.buffer, b.uv.buffer, b.idx.buffer])]);
  } catch (err) {
    post({ error: String(err instanceof Error ? err.message : err) });
  }
};
