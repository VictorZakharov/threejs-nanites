// Where the trees stand: a jittered scatter over the hills with clearings and a ragged edge, and the canopy cover
// map the far-field ground shading uses.
import * as THREE from 'three/webgpu';
import { heightAt, mulberry32 } from './noise.ts';
import { VARIANTS, isBush, isModel } from './trees.ts';
import { roadDistance, PLAZA } from './road.ts';
import { autumnOfPhase, fallOf, NEEDLES, AUTUMN } from './autumn.ts';
import { clearingAt, densityFor, forestTiles, tryBush, tryTree, type PlantConfig, type TilePlants } from './planting.ts';
import type { PlantReply, PlantRequest } from './plant-worker.ts';

const params = new URLSearchParams(location.search);

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

/** Undergrowth per tree (`?bushes=`; 0.5 on touch screens): instances of the bush variants in the same buffers. */
const BUSHES_PER_TREE = Number(params.get('bushes') ?? (matchMedia('(pointer: coarse)').matches ? 0.5 : 1.5));

/**
 * Plants about `count` trees and BUSHES_PER_TREE as many bushes (src/planting.ts, by tiles in workers: start it early,
 * it runs while the trees grow), then the statues; trees first in the buffers, then bushes, then statues.
 */
export async function plantForest(count: number): Promise<TreeInstances> {
  const radius = forestRadius(count);
  const of = (f: (i: number) => boolean) => VARIANTS.map((_, i) => (f(i) ? i : -1)).filter((i) => i >= 0);
  const pine = (i: number) => VARIANTS[i].preset.startsWith('Pine');
  const cfg: PlantConfig = {
    radius, autumn: AUTUMN,
    pine: of((i) => pine(i) && !isBush(VARIANTS[i])),
    leaf: of((i) => !pine(i) && !isBush(VARIANTS[i]) && !isModel(VARIANTS[i])),
    bushEvergreen: of((i) => isBush(VARIANTS[i]) && VARIANTS[i].leaf === 'pine'),
    bushLeafy: of((i) => isBush(VARIANTS[i]) && VARIANTS[i].leaf !== 'pine'),
    treeDensity: 0, bushDensity: 0,
  };
  cfg.treeDensity = densityFor(cfg, count, tryTree, 42);
  cfg.bushDensity = cfg.bushEvergreen.length + cfg.bushLeafy.length ? densityFor(cfg, Math.round(count * BUSHES_PER_TREE), tryBush, 7) : 0;

  // the tiles dealt out in turn (the middle first), so each worker gets a share of the dense ones
  const tiles = forestTiles(radius);
  const nWorkers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const planted = new Map<number, TilePlants>();
  await Promise.all(Array.from({ length: nWorkers }, (_, w) => new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./plant-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PlantReply>) => {
      if ('tile' in e.data) planted.set(e.data.tile, e.data);
      else {
        worker.terminate();
        if ('error' in e.data) reject(new Error(e.data.error));
        else resolve();
      }
    };
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({ cfg, tiles: tiles.filter((_, k) => k % nWorkers === w) } satisfies PlantRequest);
  })));

  // in tile order, whichever worker finished first: the same forest every time
  const order = [...planted.keys()].sort((p, q) => p - q).map((t) => planted.get(t)!);
  const statueA: number[] = [], statueB: number[] = [];
  const statues = placeStatues(radius, statueA, statueB);
  const nTrees = order.reduce((n, p) => n + p.trees.length / 8, 0), nBushes = order.reduce((n, p) => n + p.bushes.length / 8, 0);
  const total = nTrees + nBushes + statues;
  const a = new Float32Array(total * 4), b = new Float32Array(total * 4);
  let k = 0;
  for (const kind of ['trees', 'bushes'] as const)
    for (const p of order) {
      const src = p[kind];
      // (plain copies: a subarray per instance was 5M short-lived objects, ~0.2 s of the main thread)
      for (let i = 0; i < src.length; i += 8, k++) {
        const o = k * 4;
        a[o] = src[i]; a[o + 1] = src[i + 1]; a[o + 2] = src[i + 2]; a[o + 3] = src[i + 3];
        b[o] = src[i + 4]; b[o + 1] = src[i + 5]; b[o + 2] = src[i + 6]; b[o + 3] = src[i + 7];
      }
    }
  a.set(statueA, k * 4);
  b.set(statueB, k * 4);
  return { a, b, radius, trees: nTrees, statues };
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
  // the rotation that turns Lucy's front (-z after tools/nanite-model.ts stood her up) towards (dx, dz)
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
