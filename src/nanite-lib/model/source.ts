// A plain triangle mesh as a Nanite variant's source (the shape trees have, with no leaves): positions scaled to
// metres, smooth vertex normals (area weighted), uvs from the position (planar, 1 per metre) so a stone texture
// covers it. Used at load time (decode.ts) and when encoding (encode.ts).
import type { BarkSource, LeafSource } from '../dag/types.ts';

export interface ModelSource {
  bark: BarkSource;
  leaves: LeafSource;
  radius: number; // around the vertical axis through the base's centre, like a tree's
  height: number;
}

/** `pos`: the model at height 1, base at y = 0 (as encode.ts takes it); `height`: metres. */
export function modelSource(pos: Float32Array, idx: Uint32Array, height: number): ModelSource {
  const n = pos.length / 3;
  const p = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i++) p[i] = pos[i] * height;
  // (summed in doubles: the file's reader sums the same faces in another order, decode.ts, and in floats a vertex whose
  // faces nearly cancel came out turned round)
  const acc = new Float64Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // (twice the area)
    for (const o of [a, b, c]) { acc[o] += nx; acc[o + 1] += ny; acc[o + 2] += nz; }
  }
  smoothCancelled(acc, idx);
  const nrm = new Float32Array(pos.length);
  const uv = new Float32Array(n * 2);
  let r = 0;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1;
    nrm[i * 3] = acc[i * 3] / l; nrm[i * 3 + 1] = acc[i * 3 + 1] / l; nrm[i * 3 + 2] = acc[i * 3 + 2] / l;
    if (nrm[i * 3] === 0 && nrm[i * 3 + 1] === 0 && nrm[i * 3 + 2] === 0) nrm[i * 3 + 1] = 1; // (no neighbour had one)
    uv[i * 2] = x - z * 0.7; // (planar: an angle round the axis has a seam where u jumps a whole turn)
    uv[i * 2 + 1] = y + z * 0.3;
    r = Math.max(r, Math.hypot(x, y - height / 2, z));
  }
  const none = new Float32Array(0);
  return { bark: { pos: p, nrm, uv, idx }, leaves: { pos: none, nrm: none, uv: none, vpl: 4 }, radius: r, height };
}

/**
 * Vertices whose faces cancel exactly (back-to-back flaps of the scan: Lucy has ~1.8k) have no normal, and the shader
 * normalizing (0, 0, 0) got NaN: every triangle touching one was black. They take their neighbours' normals instead,
 * a few rounds for neighbours that had none either. In place, on the summed (unnormalized) normals.
 */
function smoothCancelled(acc: Float64Array, idx: Uint32Array): void {
  const isZero = (v: number): boolean => acc[v * 3] === 0 && acc[v * 3 + 1] === 0 && acc[v * 3 + 2] === 0;
  for (let round = 0; round < 4; round++) {
    const todo = new Map<number, number[]>();
    for (let v = 0; v < acc.length / 3; v++) if (isZero(v)) todo.set(v, [0, 0, 0]);
    if (!todo.size) return;
    for (let t = 0; t < idx.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const s = todo.get(idx[t + k]);
        if (!s) continue;
        for (const o of [idx[t + (k + 1) % 3], idx[t + (k + 2) % 3]]) {
          if (todo.has(o)) continue;
          const l = Math.hypot(acc[o * 3], acc[o * 3 + 1], acc[o * 3 + 2]);
          s[0] += acc[o * 3] / l; s[1] += acc[o * 3 + 1] / l; s[2] += acc[o * 3 + 2] / l;
        }
      }
    }
    for (const [v, s] of todo) acc.set(s, v * 3);
  }
}
