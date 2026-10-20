// Downloads and decodes a model file (decode.ts) off the main thread: Lucy's meshopt decode and rebuilt normals took
// ~0.5 s of the main thread while loading (~1.5 s at a phone's speed). Its header is posted as soon as it has
// arrived (the forest sizes its buffers by it and doesn't wait for the ~5 MB download), then the model.
import { decodeModel, readHeader } from './decode.ts';

self.onmessage = async (e: MessageEvent<{ url: string; height: number }>) => {
  const post = (msg: unknown, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    const res = await fetch(e.data.url);
    if (!res.ok || !res.body) throw new Error(`${e.data.url}: ${res.status}`);
    const reader = res.body.getReader(), parts: Uint8Array[] = [];
    let got = 0, header = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (!header && got >= 4) {
        const head = readHeader(concat(parts, got));
        if (head) (header = true), post({ header: head });
      }
    }
    const m = await decodeModel(concat(parts, got), e.data.height);
    const { vtx, idx, rec, meta } = m.dag, b = m.src.bark;
    post(m, [...new Set([vtx.buffer, idx.buffer, rec.buffer, meta.buffer, b.pos.buffer, b.nrm.buffer, b.uv.buffer, b.idx.buffer])]);
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
