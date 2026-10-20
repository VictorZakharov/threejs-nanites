// Planting the forest, a tile at a time (plain TypeScript: it runs in workers, src/plant-worker.ts). The land is cut
// into TILE-metre squares, each planted from its own seed with a fixed density of candidates, so a tile comes out the
// same whichever worker plants it and in whatever order: the planting is spread over several cores while the rest of
// the loading runs (it was one loop of ~7M candidates on the main thread: 7 s of the user's load).
// Trees: a ragged forest edge, the spawn point and the road kept clear, few in the clearings, pines on higher ground,
// broadleaves green / yellow / red by stands (autumn-cpu.ts). Bushes: thickest along the clearings' and the forest's
// edges, thin under the canopy, few out in the open.
import { heightAt, fbm, mulberry32, smoothstep } from './noise.ts';
import { roadDistance, SPAWN } from './road-path.ts';
import { autumnAt, withAutumn } from './autumn-cpu.ts';

export const TILE = 512; // m
const TREE_DISC = 1.35; // candidates over this x the forest radius (the edge fades out inside it)
const BUSH_DISC = 1.3;

/** Which variants a planted tree or bush can be (indices into VARIANTS), and the settings the workers can't read. */
export interface PlantConfig {
  radius: number; // the forest's (placement.ts forestRadius)
  autumn: number; // ?autumn=
  pine: number[];
  leaf: number[];
  bushEvergreen: number[];
  bushLeafy: number[];
  treeDensity: number; // candidates per m² (densityFor)
  bushDensity: number;
}

/** A tile's plants: 8 floats each, the instance's a (x, y, z, scale) and b (cos, sin, type, wind phase + autumn). */
export interface TilePlants {
  tile: number;
  trees: Float32Array;
  bushes: Float32Array;
}

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
export const clearingAt = (x: number, z: number): number => {
  if (Number.isNaN(clearingCut)) {
    const rnd = mulberry32(99), v: number[] = [];
    for (let i = 0; i < 8192; i++) v.push(clearingNoise((rnd() - 0.5) * 16000, (rnd() - 0.5) * 16000));
    v.sort((a, b) => a - b);
    clearingCut = v[Math.floor(v.length * (1 - CLEARING_SHARE))];
  }
  return 0.75 + (clearingNoise(x, z) - clearingCut) * 2.5;
};

/** The ragged forest edge: its radius at angle `ang`. */
const edgeAt = (ang: number, radius: number): number =>
  radius * (1 + 0.22 * Math.sin(ang * 3 + 0.7) + 0.12 * Math.sin(ang * 7 - 1.9) + 0.06 * Math.sin(ang * 13));
const fromSpawn2 = (x: number, z: number): number => (x - SPAWN.x) ** 2 + (z - SPAWN.z) ** 2;

type Try = (cfg: PlantConfig, x: number, z: number, rnd: () => number, out: number[] | null) => boolean;

/** A tree candidate at (x, z): kept (and appended to `out`, if given) or not. */
export const tryTree: Try = (cfg, x, z, rnd, out) => {
  const r = Math.hypot(x, z);
  if (r > cfg.radius * TREE_DISC) return false;
  // ragged forest edge: the boundary radius wobbles with the angle, and density fades out past it
  const edge = edgeAt(Math.atan2(z, x), cfg.radius);
  if (r > edge && rnd() > Math.exp(-(r - edge) / 35)) return false;
  if (fromSpawn2(x, z) < 14 * 14) return false; // keep the spawn point clear
  if (roadDistance(x, z) < 3.5) return false; // (the road and the plaza: src/road.ts)
  if (clearingAt(x, z) > 0.75 && rnd() < 0.9) return false;
  if (!out) return true;
  const y = heightAt(x, z);
  const pineBias = smoothstep(y, -10, 30) * 0.7 + (Math.sin(x * 0.004 - z * 0.006) * 0.5 + 0.5) * 0.4;
  const pool = rnd() < pineBias ? cfg.pine : cfg.leaf;
  const type = pool[Math.floor(rnd() * pool.length)];
  const scale = 0.75 + rnd() * 0.5;
  const rot = rnd() * Math.PI * 2;
  const turn = pool === cfg.pine ? 0 : autumnAt(x, z, rnd(), cfg.autumn);
  out.push(x, y - 0.3, z, scale, Math.cos(rot), Math.sin(rot), type, withAutumn(rnd() * 6.28, turn));
  return true;
};

/** A bush candidate at (x, z). */
export const tryBush: Try = (cfg, x, z, rnd, out) => {
  const r = Math.hypot(x, z);
  if (r > cfg.radius * BUSH_DISC) return false;
  if (fromSpawn2(x, z) < 6 * 6 || roadDistance(x, z) < 1.2) return false; // (the spawn point, the road)
  const c = clearingAt(x, z);
  const rim = Math.exp(-(((c - 0.72) / 0.12) ** 2)); // the clearings' edges
  const forestRim = Math.exp(-(((r - edgeAt(Math.atan2(z, x), cfg.radius)) / 60) ** 2));
  const keep = c > 0.75 ? 0.08 + 0.9 * rim : 0.25 + 0.75 * Math.max(rim, forestRim);
  if (rnd() > keep) return false;
  if (!out) return true;
  const y = heightAt(x, z);
  const evergreen = cfg.bushEvergreen.length > 0 && rnd() < smoothstep(y, 0, 40) * 0.6 + 0.15;
  const pool = evergreen ? cfg.bushEvergreen : cfg.bushLeafy;
  const rot = rnd() * Math.PI * 2;
  const scale = 0.8 + rnd() * 0.9;
  const turn = evergreen ? 0 : autumnAt(x, z, rnd(), cfg.autumn);
  out.push(x, y - 0.15, z, scale, Math.cos(rot), Math.sin(rot), pool[Math.floor(rnd() * pool.length)], withAutumn(rnd() * 6.28, turn));
  return true;
};

/**
 * Candidates per m² that keep `count` plants on average: the share of candidates `tryOne` keeps, sampled over its
 * disc (radius x `disc`). The tiles then plant that density, so the totals land within a fraction of a percent.
 */
export function densityFor(cfg: PlantConfig, count: number, tryOne: Try, seed: number): number {
  if (count <= 0) return 0;
  const disc = cfg.radius * (tryOne === tryTree ? TREE_DISC : BUSH_DISC);
  const rnd = mulberry32(seed), M = 40000;
  let kept = 0;
  for (let i = 0; i < M; i++) {
    const ang = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * disc;
    if (tryOne(cfg, Math.cos(ang) * r, Math.sin(ang) * r, rnd, null)) kept++;
  }
  return count / (Math.max(kept, 1) / M) / (Math.PI * disc * disc);
}

/** The tile grid: `n` tiles a side from `origin` (m), covering the candidates' discs. */
export function tileGrid(radius: number): { n: number; origin: number } {
  const n = Math.ceil((radius * TREE_DISC * 2) / TILE);
  return { n, origin: (-n * TILE) / 2 };
}

/** The tiles that reach into the forest, the middle first. */
export function forestTiles(radius: number): number[] {
  const { n, origin } = tileGrid(radius);
  const tiles: { t: number; d: number }[] = [];
  for (let tz = 0; tz < n; tz++)
    for (let tx = 0; tx < n; tx++) {
      // (the tile's nearest point to the middle)
      const x = Math.max(origin + tx * TILE, Math.min(0, origin + (tx + 1) * TILE));
      const z = Math.max(origin + tz * TILE, Math.min(0, origin + (tz + 1) * TILE));
      const d = Math.hypot(x, z);
      if (d < radius * TREE_DISC) tiles.push({ t: tz * n + tx, d });
    }
  return tiles.sort((p, q) => p.d - q.d).map((p) => p.t);
}

/** Bits 0..9 of v spread to the even bits (a Morton code's half). */
const spread = (v: number): number => {
  v &= 0x3ff;
  v = (v | (v << 8)) & 0x00ff00ff;
  v = (v | (v << 4)) & 0x0f0f0f0f;
  v = (v | (v << 2)) & 0x33333333;
  return (v | (v << 1)) & 0x55555555;
};

/**
 * The plants (8 floats each) in Morton order of their place in the tile at (x0, z0): runs of consecutive ones are then
 * compact patches, and the instance passes cull whole runs at once (src/nanite-lib/gpu/chunks.ts).
 */
function mortonOrder(rec: number[], x0: number, z0: number): Float32Array {
  const n = rec.length / 8, q = (v: number) => Math.min(1023, Math.max(0, Math.floor((v / TILE) * 1024)));
  const key = new Uint32Array(n);
  for (let i = 0; i < n; i++) key[i] = spread(q(rec[i * 8] - x0)) | (spread(q(rec[i * 8 + 2] - z0)) << 1);
  const order = Array.from({ length: n }, (_, i) => i).sort((p, r) => key[p] - key[r]);
  const out = new Float32Array(n * 8);
  order.forEach((src, j) => {
    for (let k = 0; k < 8; k++) out[j * 8 + k] = rec[src * 8 + k];
  });
  return out;
}

/** Plants tile `t`: its own seeds, a fixed number of candidates for its area. */
export function plantTile(cfg: PlantConfig, t: number): TilePlants {
  const { n, origin } = tileGrid(cfg.radius);
  const x0 = origin + (t % n) * TILE, z0 = origin + Math.floor(t / n) * TILE;
  const plant = (density: number, tryOne: Try, salt: number): Float32Array => {
    const out: number[] = [];
    const rnd = mulberry32(Math.imul(t + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b));
    for (let k = Math.floor(density * TILE * TILE + rnd()); k > 0; k--) tryOne(cfg, x0 + rnd() * TILE, z0 + rnd() * TILE, rnd, out);
    return mortonOrder(out, x0, z0);
  };
  return { tile: t, trees: plant(cfg.treeDensity, tryTree, 1), bushes: plant(cfg.bushDensity, tryBush, 2) };
}
