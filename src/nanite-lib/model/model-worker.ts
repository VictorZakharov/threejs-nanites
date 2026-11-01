// Downloads and decodes a model file (decode.ts) off the main thread: Lucy's meshopt decode and rebuilt normals took
// ~0.5 s of the main thread while loading (~1.5 s at a phone's speed). Its header is posted as soon as it has
// arrived (the forest sizes its buffers by it and doesn't wait for the ~5 MB download), then its coarse copy as soon
// as that has (format 4: drawn while the rest downloads), then the model.
import { coarseEnd, decodeCoarse, decodeModel, readHeader, type LoadedModel } from './decode.ts';

self.onmessage = async (e: MessageEvent<{ url: string; height: number }>) => {
  const post = (msg: unknown, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    const res = await fetch(e.data.url);
    if (!res.ok || !res.body) throw new Error(`${e.data.url}: ${res.status}`);
    const reader = res.body.getReader(), parts: Uint8Array[] = [];
    let got = 0, header = false, coarseAt = Infinity;
    const send = (m: LoadedModel, wrap: (m: LoadedModel) => unknown): void => {
      const { vtx, idx, rec, meta } = m.dag, b = m.src.bark;
      post(wrap(m), [...new Set([vtx.buffer, idx.buffer, rec.buffer, meta.buffer, b.pos.buffer, b.nrm.buffer, b.uv.buffer, b.idx.buffer])]);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (!header && got >= 4) {
        const all = concat(parts, got), head = readHeader(all);
        if (head) (header = true), (coarseAt = coarseEnd(all, head) || Infinity), post({ header: head });
      }
      if (got >= coarseAt) {
        coarseAt = Infinity;
        const c = await decodeCoarse(concat(parts, got), e.data.height);
        if (c) send(c, (coarse) => ({ coarse }));
      }
    }
    send(await decodeModel(concat(parts, got), e.data.height), (m) => m);
  } catch (err) {
    post({ error: String(err instanceof Error ? err.message : err) });
  }
};

function concat(parts: Uint8Array[], n: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  parts.splice(0, parts.length, out);
  return out;
}
