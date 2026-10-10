// Where the trees stand: a jittered scatter over the hills with clearings and a ragged edge, and the canopy cover
// map the far-field ground shading uses.
import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.ts';
import { VARIANTS, isBush } from './trees.ts';

const params = new URLSearchParams(location.search);

function mulberry32(seed: number): () => number {
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
export const forestRadius = (count: number): number => Math.sqrt((count * TREE_SPACING * TREE_SPACING) / Math.PI) * 1.15;

/** Canopy cover (0..1) of the ground on a grid over the forest, for the far-field ground darkening. */
export function forestDensity({ a, b, radius }: TreeInstances): { texture: THREE.DataTexture; extent: number } {
  const N = 1024, extent = radius * 1.8, cell = (extent * 2) / N;
  const cov = new Float32Array(N * N);
  const crown = Number(params.get('crown') ?? 100) / (cell * cell); // ~60 m^2 of shade per tree (scaled by tree size; low sun: long shadows)
  for (let i = 0; i < a.length; i += 4) {
    if (isBush(VARIANTS[b[i + 2]])) continue; // (cover is the trees' canopy)
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

/** Per tree: `a` = (x, y, z, scale), `b` = (cos, sin of the rotation, type, wind phase); `radius` of the forest. */
export interface TreeInstances {
  a: Float32Array;
  b: Float32Array;
  radius: number;
  trees: number; // the first `trees` instances are trees, the rest bushes
}

export function placeTrees(count: number): TreeInstances {
  const rnd = mulberry32(42);
  const radius = forestRadius(count);
  const a: number[] = [], b: number[] = [];
  const pineTypes = VARIANTS.map((v, i) => (v.preset.startsWith('Pine') ? i : -1)).filter((i) => i >= 0);
  const leafTypes = VARIANTS.map((v, i) => (v.preset.startsWith('Pine') || isBush(v) ? -1 : i)).filter((i) => i >= 0);
  let tries = 0;
  while (a.length / 4 < count && tries++ < count * 20) {
    const ang = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius * 1.35;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    // ragged forest edge: the boundary radius wobbles with the angle, and density fades out past it
    const edge = radius * (1 + 0.22 * Math.sin(ang * 3 + 0.7) + 0.12 * Math.sin(ang * 7 - 1.9) + 0.06 * Math.sin(ang * 13));
    if (r > edge && rnd() > Math.exp(-(r - edge) / 35)) continue;
    if (Math.hypot(x - 20, z - 40) < 14) continue; // keep the spawn point clear
    // clearings
    const clearing = clearingAt(x, z);
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
  const trees = a.length / 4;
  placeBushes(Math.round(count * BUSHES_PER_TREE), radius, a, b);
  return { a: new Float32Array(a), b: new Float32Array(b), radius, trees };
}

/** Undergrowth per tree (`?bushes=`; 0.5 on touch screens): instances of the bush variants in the same buffers. */
const BUSHES_PER_TREE = Number(params.get('bushes') ?? (matchMedia('(pointer: coarse)').matches ? 0.5 : 1.5));

/** Clearing field (the tree scatter skips where it's over 0.75): bushes gather along its edges. */
const clearingAt = (x: number, z: number): number => Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.013 - 0.7) + Math.sin(x * 0.031 + z * 0.027) * 0.4;

/**
 * Scatters bushes over the forest: thickest along the clearings' edges and the forest edge (where the light gets in),
 * thin under the canopy, few out in the open; the evergreen kind more on the higher ground.
 */
function placeBushes(count: number, radius: number, a: number[], b: number[]): void {
  const rnd = mulberry32(7);
  const types = VARIANTS.map((v, i) => (isBush(v) ? i : -1)).filter((i) => i >= 0);
  const evergreen = types.filter((i) => VARIANTS[i].leaf === 'pine'), leafy = types.filter((i) => VARIANTS[i].leaf !== 'pine');
  let placed = 0, tries = 0;
  while (placed < count && tries++ < count * 30) {
    const ang = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius * 1.3;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (Math.hypot(x - 20, z - 40) < 6) continue; // (the spawn point)
    const c = clearingAt(x, z);
    const rim = Math.exp(-(((c - 0.72) / 0.12) ** 2)); // the clearings' edges
    const edge = radius * (1 + 0.22 * Math.sin(ang * 3 + 0.7) + 0.12 * Math.sin(ang * 7 - 1.9) + 0.06 * Math.sin(ang * 13));
    const forestRim = Math.exp(-(((r - edge) / 60) ** 2));
    const keep = c > 0.75 ? 0.08 + 0.9 * rim : 0.25 + 0.75 * Math.max(rim, forestRim);
    if (rnd() > keep) continue;
    const y = heightAt(x, z);
    const pool = evergreen.length && rnd() < THREE.MathUtils.smoothstep(y, 0, 40) * 0.6 + 0.15 ? evergreen : leafy;
    const rot = rnd() * Math.PI * 2;
    a.push(x, y - 0.15, z, 0.8 + rnd() * 0.9);
    b.push(Math.cos(rot), Math.sin(rot), pool[Math.floor(rnd() * pool.length)], rnd() * 6.28);
    placed++;
  }
}
