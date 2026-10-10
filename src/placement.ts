// Where the trees stand: a jittered scatter over the hills with clearings and a ragged edge, and the canopy cover
// map the far-field ground shading uses.
import * as THREE from 'three/webgpu';
import { heightAt, fbm } from './terrain.ts';
import { VARIANTS, isBush, isModel } from './trees.ts';
import { roadDistance, PLAZA } from './road.ts';
import { autumnAt, withAutumn, autumnOfPhase, fallOf, NEEDLES } from './autumn.ts';

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

/**
 * Canopy cover (0..1, red) of the ground on a grid over the forest, for the far-field ground darkening; and the fallen
 * leaves under it (src/ground/floor.ts): green their amount (0..1: the trees' fallOf, weighted by crown), blue their
 * autumn level / 2 (src/autumn.ts); conifers drop a thick mat of needles (level 0).
 */
export function forestDensity({ a, b, radius }: TreeInstances): { texture: THREE.DataTexture; extent: number } {
  const N = 1024, extent = radius * 1.8, cell = (extent * 2) / N;
  const cov = new Float32Array(N * N), fall = new Float32Array(N * N), hue = new Float32Array(N * N);
  const crown = Number(params.get('crown') ?? 100) / (cell * cell); // ~60 m^2 of shade per tree (scaled by tree size; low sun: long shadows)
  for (let i = 0; i < a.length; i += 4) {
    const v = VARIANTS[b[i + 2]];
    if (isBush(v) || isModel(v)) continue; // (cover is the trees' canopy)
    const x = Math.floor((a[i] / (extent * 2) + 0.5) * N), z = Math.floor((a[i + 2] / (extent * 2) + 0.5) * N);
    if (x < 0 || z < 0 || x >= N || z >= N) continue;
    const w = crown * a[i + 3] * a[i + 3], turn = autumnOfPhase(b[i + 3]);
    const f = w * (v.leaf === 'pine' ? NEEDLES : fallOf(turn)); // (the grass thins under the needles too)
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
  const tex = new THREE.DataTexture(data, N, N);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { texture: tex, extent };
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

/** Per tree: `a` = (x, y, z, scale), `b` = (cos, sin of the rotation, type, wind phase + autumn: src/autumn.ts); `radius` of the forest. */
export interface TreeInstances {
  a: Float32Array;
  b: Float32Array;
  radius: number;
  trees: number; // the first `trees` instances are trees, then the bushes, then `statues` models
  statues: number;
}

export function placeTrees(count: number): TreeInstances {
  const rnd = mulberry32(42);
  const radius = forestRadius(count);
  const a: number[] = [], b: number[] = [];
  const pineTypes = VARIANTS.map((v, i) => (v.preset.startsWith('Pine') ? i : -1)).filter((i) => i >= 0);
  const leafTypes = VARIANTS.map((v, i) => (v.preset.startsWith('Pine') || isBush(v) || isModel(v) ? -1 : i)).filter((i) => i >= 0);
  let tries = 0;
  while (a.length / 4 < count && tries++ < count * 20) {
    const ang = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius * 1.35;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    // ragged forest edge: the boundary radius wobbles with the angle, and density fades out past it
    const edge = radius * (1 + 0.22 * Math.sin(ang * 3 + 0.7) + 0.12 * Math.sin(ang * 7 - 1.9) + 0.06 * Math.sin(ang * 13));
    if (r > edge && rnd() > Math.exp(-(r - edge) / 35)) continue;
    if (Math.hypot(x - 20, z - 40) < 14) continue; // keep the spawn point clear
    if (roadDistance(x, z) < 3.5) continue; // (the road and the plaza: src/road.ts)
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
    const turn = pool === pineTypes ? 0 : autumnAt(x, z, rnd());
    b.push(Math.cos(rot), Math.sin(rot), type, withAutumn(rnd() * 6.28, turn));
  }
  const trees = a.length / 4;
  placeBushes(Math.round(count * BUSHES_PER_TREE), radius, a, b);
  const statues = placeStatues(radius, a, b);
  return { a: new Float32Array(a), b: new Float32Array(b), radius, trees, statues };
}

/** Undergrowth per tree (`?bushes=`; 0.5 on touch screens): instances of the bush variants in the same buffers. */
const BUSHES_PER_TREE = Number(params.get('bushes') ?? (matchMedia('(pointer: coarse)').matches ? 0.5 : 1.5));

/** Clearing field (the tree scatter skips where it's over 0.75): bushes gather along its edges. */
/**
 * Clearing field: over 0.75 is a clearing (about CLEARING_SHARE of the land), the edges just under it. Domain-warped
 * fractal noise, so clearings come in all sizes and shapes; it was a sum of sines, and from the air the forest was a
 * lattice of same-sized gaps (the user: "pattern of trees looks repetitive").
 */
const CLEARING_SHARE = 0.1;
const clearingNoise = (x: number, z: number): number => {
  const wx = fbm(x / 900 + 3.1, z / 900 - 1.7, 2) - 0.5, wz = fbm(x / 900 - 5.3, z / 900 + 8.2, 2) - 0.5;
  return fbm(x / 320 + wx * 1.6 + 19.7, z / 320 + wz * 1.6 - 4.4, 4);
};
let clearingCut = NaN; // the noise's (1 - CLEARING_SHARE) quantile, sampled once
const clearingAt = (x: number, z: number): number => {
  if (Number.isNaN(clearingCut)) {
    const rnd = mulberry32(99), v: number[] = [];
    for (let i = 0; i < 8192; i++) v.push(clearingNoise((rnd() - 0.5) * 16000, (rnd() - 0.5) * 16000));
    v.sort((a, b) => a - b);
    clearingCut = v[Math.floor(v.length * (1 - CLEARING_SHARE))];
  }
  return 0.75 + (clearingNoise(x, z) - clearingCut) * 2.5;
};

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
    if (Math.hypot(x - 20, z - 40) < 6 || roadDistance(x, z) < 1.2) continue; // (the spawn point, the road)
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
    const turn = pool === evergreen ? 0 : autumnAt(x, z, rnd());
    b.push(Math.cos(rot), Math.sin(rot), pool[Math.floor(rnd() * pool.length)], withAutumn(rnd() * 6.28, turn));
    placed++;
  }
}

/** Extra statues scattered over the clearings (`?statues=N`, a stress test: a million triangles each); the plaza's ring is always there. */
const STATUES = Number(params.get('statues') ?? 0);

/**
 * Models in the scene: the plaza's ring at the road's end (src/road.ts), each facing its middle, then up to STATUES
 * more on a jittered grid (14 m) over the clearings. A proof that the pipeline takes any mesh: each is a million
 * triangles.
 */
const PLINTH = 0.7; // m: Lucy's base radius at scale 1 (her 4 m), a little over

function placeStatues(radius: number, a: number[], b: number[]): number {
  const types = VARIANTS.map((v, i) => (isModel(v) ? i : -1)).filter((i) => i >= 0);
  if (!types.length) return 0;
  const rnd = mulberry32(13);
  // on the lowest ground under the plinth (by its centre, one edge floated on a slope: the user)
  const add = (x: number, z: number, scale: number, face: number, type: number) => {
    let y = heightAt(x, z);
    for (let k = 0; k < 12; k++) y = Math.min(y, heightAt(x + Math.cos(k * 0.5236) * PLINTH * scale, z + Math.sin(k * 0.5236) * PLINTH * scale));
    a.push(x, y - 0.05, z, scale);
    b.push(Math.cos(face), Math.sin(face), type, 0); // (no wind: phase 0)
  };
  // the rotation that turns Lucy's front (-z after tools/nanite-model.mjs stood her up) towards (dx, dz)
  const faceTo = (dx: number, dz: number) => Math.atan2(-dx, dz) + Math.PI;
  const ring = params.get('plaza') === '0' ? 0 : PLAZA.statues; // (?plaza=0: no ring, for A/B)
  for (let k = 0; k < ring; k++) {
    const t = (k / PLAZA.statues) * Math.PI * 2;
    const x = PLAZA.x + Math.cos(t) * PLAZA.ring, z = PLAZA.z + Math.sin(t) * PLAZA.ring;
    add(x, z, 1, faceTo(PLAZA.x - x, PLAZA.z - z), types[k % types.length]);
  }
  let n = ring;
  const step = 14, half = Math.ceil((radius * 1.2) / step);
  for (let gz = -half; gz <= half && n < ring + STATUES; gz++)
    for (let gx = -half; gx <= half && n < ring + STATUES; gx++) {
      const x = (gx + (rnd() - 0.5) * 0.6) * step, z = (gz + (rnd() - 0.5) * 0.6) * step;
      if (clearingAt(x, z) < 0.85 || Math.hypot(x, z) > radius || roadDistance(x, z) < 4) continue;
      add(x, z, 0.8 + rnd() * 0.8, (rnd() - 0.5) * 6.28, types[Math.floor(rnd() * types.length)]);
      n++;
    }
  return n;
}
