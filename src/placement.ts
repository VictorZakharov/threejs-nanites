// Where the trees stand: a jittered scatter over the hills with clearings and a ragged edge, and the canopy cover
// map the far-field ground shading uses.
import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.ts';
import { VARIANTS } from './trees.ts';

const params = new URLSearchParams(location.search);

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scatters trees over the hills: jittered grid, noisy clearings, pines higher up. */
export const TREE_SPACING = 9;
export const MAX_ALTITUDE = 9000;
/** Radius (m) of the forest disc for `count` trees. */
export const forestRadius = (count) => Math.sqrt((count * TREE_SPACING * TREE_SPACING) / Math.PI) * 1.15;

/** Canopy cover (0..1) of the ground on a grid over the forest, for the far-field ground darkening. */
export function forestDensity({ a, radius }) {
  const N = 1024, extent = radius * 1.8, cell = (extent * 2) / N;
  const cov = new Float32Array(N * N);
  const crown = Number(params.get('crown') ?? 100) / (cell * cell); // ~60 m^2 of shade per tree (scaled by tree size; low sun: long shadows)
  for (let i = 0; i < a.length; i += 4) {
    const x = Math.floor((a[i] / (extent * 2) + 0.5) * N), z = Math.floor((a[i + 2] / (extent * 2) + 0.5) * N);
    if (x >= 0 && z >= 0 && x < N && z < N) cov[z * N + x] += crown * a[i + 3] * a[i + 3];
  }
  // two box blurs (~ a few tens of metres), then clamp to full cover
  let src = cov, dst = new Float32Array(N * N);
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
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) data[i * 4] = Math.round(Math.min(1, src[i]) * 255);
  const tex = new THREE.DataTexture(data, N, N);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { texture: tex, extent };
}

export function placeTrees(count) {
  const rnd = mulberry32(42);
  const radius = forestRadius(count);
  const a = [], b = [];
  const pineTypes = VARIANTS.map((v, i) => (v.preset.startsWith('Pine') ? i : -1)).filter((i) => i >= 0);
  const leafTypes = VARIANTS.map((v, i) => (v.preset.startsWith('Pine') ? -1 : i)).filter((i) => i >= 0);
  let tries = 0;
  while (a.length / 4 < count && tries++ < count * 20) {
    const ang = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius * 1.35;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    // ragged forest edge: the boundary radius wobbles with the angle, and density fades out past it
    const edge = radius * (1 + 0.22 * Math.sin(ang * 3 + 0.7) + 0.12 * Math.sin(ang * 7 - 1.9) + 0.06 * Math.sin(ang * 13));
    if (r > edge && rnd() > Math.exp(-(r - edge) / 35)) continue;
    if (Math.hypot(x - 20, z - 40) < 14) continue; // keep the spawn point clear
    // clearings
    const clearing = Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.013 - 0.7) + Math.sin(x * 0.031 + z * 0.027) * 0.4;
    if (clearing > 0.75 && rnd() < 0.9) continue;
    const y = heightAt(x, z);
    const pineBias = THREE.MathUtils.smoothstep(y, -10, 30) * 0.7 + (Math.sin(x * 0.004 - z * 0.006) * 0.5 + 0.5) * 0.4;
    const pool = rnd() < pineBias ? pineTypes : leafTypes;
    const type = pool[Math.floor(rnd() * pool.length)];
    const scale = 0.75 + rnd() * 0.5;
    const rot = rnd() * Math.PI * 2;
    a.push(x, y - 0.3, z, scale);
    b.push(Math.cos(rot), Math.sin(rot), type, rnd() * 6.28);
  }
  return { a: new Float32Array(a), b: new Float32Array(b), radius };
}
