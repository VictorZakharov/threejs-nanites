// The impostor atlas's coverage-preserving alpha scales (impostors.ts, impostorCoverage) off the main thread: per tile
// and mip level, the alpha scale that keeps the full-size tile's fraction of texels above the cut-off.
import { select } from './texture-pixels.ts';

/** The atlas read back (RGBA, half floats or bytes), its width, how many tiles, the cut-off and the tile size. */
export interface CoverageJob {
  raw: Uint16Array<ArrayBuffer> | Uint8Array<ArrayBuffer> | Float32Array<ArrayBuffer>;
  W: number;
  tiles: number;
  cut: number;
  tileW: number;
  tileH: number;
}

function coverage({ raw, W, tiles, cut, tileW, tileH }: CoverageJob): { scales: Float32Array<ArrayBuffer>; levels: number } {
  const cols = W / tileW;
  // the alpha channel as floats (half floats through a table of all 65536)
  const n = raw.length >> 2, alpha = new Float32Array(n);
  if (raw instanceof Uint16Array) {
    const table = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const e = (h >> 10) & 31, m = h & 1023;
      const v = e === 0 ? m / 1024 / 16384 : e === 31 ? 1 : (1 + m / 1024) * 2 ** (e - 15);
      table[h] = h & 0x8000 ? -v : v;
    }
    for (let i = 0; i < n; i++) alpha[i] = table[raw[i * 4 + 3]];
  } else {
    const k = raw instanceof Uint8Array ? 255 : 1;
    for (let i = 0; i < n; i++) alpha[i] = raw[i * 4 + 3] / k;
  }
  const levels = Math.log2(tileW) + 1;
  const scales = new Float32Array(tiles * levels);
  for (let t = 0; t < tiles; t++) {
    let w = tileW, h = tileH;
    let a = new Float32Array(w * h);
    const x0 = (t % cols) * tileW, y0 = Math.floor(t / cols) * tileH;
    for (let y = 0; y < h; y++) a.set(alpha.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + w), y * w);
    let target = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > cut) target++;
    target /= a.length;
    scales[t * levels] = 1;
    for (let l = 1; l < levels; l++) {
      const w2 = w >> 1, h2 = h >> 1;
      const b = new Float32Array(w2 * h2);
      for (let y = 0; y < h2; y++)
        for (let x = 0; x < w2; x++)
          b[y * w2 + x] = (a[2 * y * w + 2 * x] + a[2 * y * w + 2 * x + 1] + a[(2 * y + 1) * w + 2 * x] + a[(2 * y + 1) * w + 2 * x + 1]) / 4;
      a = b; w = w2; h = h2;
      // alpha value at the (1 - target) quantile becomes the new cut-off
      const q = select(Float32Array.from(a), Math.min(a.length - 1, Math.floor((1 - target) * a.length)));
      scales[t * levels + l] = Math.min(8, cut / Math.max(q, 1e-3));
    }
  }
  return { scales, levels };
}

self.onmessage = (e: MessageEvent<CoverageJob>) => {
  const out = coverage(e.data);
  (self as unknown as Worker).postMessage(out, [out.scales.buffer]);
};
