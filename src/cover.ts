// The canopy cover map's pixels (placement.ts CoverMap), plain TypeScript for its worker (cover-worker.ts): ~1.1 s of
// a phone's main thread while loading, and the shader compiles wait for the main thread (they yield to it).
import { autumnOfPhase, fallOf, NEEDLES } from './autumn-cpu.ts';

export interface CoverJob {
  a: Float32Array<ArrayBuffer>; // the trees' instances (x, y, z, scale)
  b: Float32Array<ArrayBuffer>; // (cos, sin, type, wind phase + autumn)
  /** Per type: 0 not canopy (bushes, models), 1 broadleaf, 2 conifer. */
  kinds: number[];
  N: number;
  extent: number;
  crown: number; // m² of shade per tree at scale 1
}

/** Red canopy cover, green the fallen leaves' amount, blue their autumn level / 2 (RGBA bytes, N x N). */
export function coverPixels({ a, b, kinds, N, extent, crown: crownM2 }: CoverJob): Uint8Array<ArrayBuffer> {
  const cell = (extent * 2) / N;
  const cov = new Float32Array(N * N), fall = new Float32Array(N * N), hue = new Float32Array(N * N);
  const crown = crownM2 / (cell * cell); // (scaled by tree size; low sun: long shadows)
  for (let i = 0; i < a.length; i += 4) {
    const kind = kinds[b[i + 2]];
    if (!kind) continue; // (cover is the trees' canopy)
    const x = Math.floor((a[i] / (extent * 2) + 0.5) * N), z = Math.floor((a[i + 2] / (extent * 2) + 0.5) * N);
    if (x < 0 || z < 0 || x >= N || z >= N) continue;
    const w = crown * a[i + 3] * a[i + 3], turn = autumnOfPhase(b[i + 3]);
    const f = w * (kind === 2 ? NEEDLES : fallOf(turn)); // (the grass thins under the needles too)
    cov[z * N + x] += w;
    fall[z * N + x] += f;
    hue[z * N + x] += f * turn;
  }
  const [c, fl, h] = [cov, fall, hue].map((m) => blur(m, N));
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(Math.min(1, c[i]) * 255);
    data[i * 4 + 1] = c[i] > 1e-4 ? Math.round(Math.min(1, fl[i] / c[i]) * 255) : 0;
    data[i * 4 + 2] = fl[i] > 1e-4 ? Math.round(Math.min(1, h[i] / fl[i] / 2) * 255) : 0;
  }
  return data;
}

/** Two box blurs each way (~ a few tens of metres). */
function blur(m: Float32Array<ArrayBuffer>, N: number): Float32Array<ArrayBuffer> {
  let src = m, dst = new Float32Array(N * N);
  for (let pass = 0; pass < 4; pass++) {
    const horiz = pass % 2 === 0;
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        let sum = 0;
        for (let k = -2; k <= 2; k++) {
          const xx = horiz ? Math.min(N - 1, Math.max(0, x + k)) : x, zz = horiz ? z : Math.min(N - 1, Math.max(0, z + k));
          sum += src[zz * N + xx];
        }
        dst[z * N + x] = sum / 5;
      }
    [src, dst] = [dst, src];
  }
  return src;
}
