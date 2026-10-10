// The forest floor's maps (albedo, normal, height), procedural: ported from the user's last-stand (gd-clone,
// src/core/pbr.ts forestFloor + buildPBR, src/util.ts noise). Soil, twigs and pebbles (the leaves: floor-leaves.ts),
// 5 m a tile at 1024 px; what lies highest shows, and the height (roughness map's red channel) drives the
// parallax relief (src/ground/relief.ts). Pure maths, no DOM: built in a worker (floor-worker.ts).

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => t * t * (3 - 2 * t);
type Noise2D = (x: number, y: number) => number;

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePeriodicNoise(seed: number, period: number): Noise2D {
  const rng = mulberry(seed);
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const at = (x: number, y: number) => grid[((y % period + period) % period) * period + ((x % period + period) % period)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let xf = x - xi, yf = y - yi;
    xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
  };
}

/** Fractal noise, tileable over the unit square (u, v in [0, 1)). */
export function makeFbm(seed: number, basePeriod: number, octaves = 4): Noise2D {
  const layers: Noise2D[] = [];
  for (let o = 0; o < octaves; o++) layers.push(makePeriodicNoise(seed + o * 101, basePeriod << o));
  return (u, v) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const p = basePeriod << o;
      sum += layers[o](u * p, v * p) * amp;
      norm += amp; amp *= 0.5;
    }
    return sum / norm;
  };
}

/** Heights are stored as cm / HEIGHT_CM (0..1) in every map. */
export const HEIGHT_CM = 4;

/** Per-pixel output of a PBR sampler: height (cm), albedo rgb (0..1), roughness. */
interface PBRSample { h: number; r: number; g: number; b: number; rough: number }
type PBRSampler = (u: number, v: number, out: PBRSample) => void;
/** A material's maps as RGBA pixels, `size` square. */
export interface PBRData { size: number; albedo: Uint8ClampedArray<ArrayBuffer>; normal: Uint8ClampedArray<ArrayBuffer>; rough: Uint8ClampedArray<ArrayBuffer> }

function buildPBR(size: number, sampler: PBRSampler, normalStrength = 2.5): PBRData {
  const n = size * size;
  const height = new Float32Array(n);
  const albedo = new Uint8ClampedArray(n * 4);
  const rough = new Uint8ClampedArray(n * 4);
  const out: PBRSample = { h: 0, r: 0, g: 0, b: 0, rough: 0.8 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      sampler(x / size, y / size, out);
      const i = y * size + x;
      height[i] = out.h;
      albedo[i * 4] = out.r * 255; albedo[i * 4 + 1] = out.g * 255; albedo[i * 4 + 2] = out.b * 255; albedo[i * 4 + 3] = 255;
      const rv = out.rough * 255;
      rough[i * 4] = rv; rough[i * 4 + 1] = rv; rough[i * 4 + 2] = rv; rough[i * 4 + 3] = 255;
    }
  }
  const normal = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size, xr = (x + 1) % size, yu = (y - 1 + size) % size, yd = (y + 1) % size;
      const dx = (height[y * size + xr] - height[y * size + xl]) * normalStrength;
      const dy = (height[yd * size + x] - height[yu * size + x]) * normalStrength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      normal[i] = (-dx / len * 0.5 + 0.5) * 255;
      normal[i + 1] = (dy / len * 0.5 + 0.5) * 255;
      normal[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;
    }
  }
  // (a fixed scale, shared with the leaf layers: floor-leaves.ts)
  for (let i = 0; i < n; i++) rough[i * 4] = clamp(height[i] / HEIGHT_CM, 0, 1) * 255;
  return { size, albedo, normal, rough };
}

export function makeScatter(seed: number, cells: number, share: number) {
  const rng = mulberry(seed), n = cells * cells;
  const cx = new Float32Array(n), cy = new Float32Array(n), size = new Float32Array(n), id = new Float32Array(n);
  const cos = new Float32Array(n), sin = new Float32Array(n), on = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const turn = rng() * Math.PI * 2;
    cx[i] = rng(); cy[i] = rng(); cos[i] = Math.cos(turn); sin[i] = Math.sin(turn); size[i] = rng(); id[i] = rng();
    on[i] = rng() < share ? 1 : 0;
  }
  const found = { count: 0, dx: new Float32Array(9), dy: new Float32Array(9), k: new Int32Array(9) };
  const near = (u: number, v: number) => {
    const x = u * cells, y = v * cells, xi = Math.floor(x), yi = Math.floor(y);
    found.count = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      // (wrapped round the tile by a comparison: the point is in it, so a neighbour is at most a cell outside)
      const gx = xi + ox, gy = yi + oy;
      const wx = gx < 0 ? gx + cells : gx >= cells ? gx - cells : gx, wy = gy < 0 ? gy + cells : gy >= cells ? gy - cells : gy;
      const k = wy * cells + wx;
      if (!on[k]) continue;
      const j = found.count++;
      found.dx[j] = gx + cx[k] - x; found.dy[j] = gy + cy[k] - y; found.k[j] = k;
    }
    return found;
  };
  return { near, cos, sin, size, id, cells };
}

/** the forest floor's tile (m) and its texels (cm a pixel: 5 m over 1024) */
export const FLOOR_TILE = 5;
export const FLOOR_CM = FLOOR_TILE * 100 / 1024;
/**
 * Forest floor (5 m a tile, heights in cm): clumpy dark soil, twigs lying across it and pebbles from 2 to 6 cm across.
 * At each point what lies highest is what shows. The fallen leaves are separate layers per kind of tree
 * (floor-leaves.ts), laid over this in the shader by the tree above (floor.ts). Moss is added in world space.
 */
export function forestFloor(): PBRData {
  const soil = makeFbm(29, 24, 4), crumbs = makeFbm(31, 160, 2);
  const twigCells = 24, pebbleCells = 32;
  const twigs = makeScatter(53, twigCells, 0.18), pebbles = makeScatter(59, pebbleCells, 0.22);
  const cm = (cells: number) => FLOOR_TILE * 100 / cells;   // a cell of a grid, cm
  return buildPBR(1024, (u, v, o) => {
    // the soil: clumpy, crumbs over it, darker where it's damp
    const s = soil(u, v), c = crumbs(u, v);
    let h = s * 0.9 + c * 0.25, r = 0.13, g = 0.09, b = 0.06, rough = 0.95;
    const damp = smooth(clamp((s - 0.55) / 0.2, 0, 1));
    const k = (0.75 + c * 0.5) * (1 - damp * 0.3);
    r *= k; g *= k; b *= k;
    const lay = (top: number, cr: number, cg: number, cb: number, ro: number) => {
      if (top <= h) return;
      h = top; r = cr; g = cg; b = cb; rough = ro;
    };
    // twigs: capsules lying over the litter, 16 to 38 cm long and 1.2 to 2 cm thick
    {
      const near = twigs.near(u, v), size = cm(twigCells);
      for (let j = 0; j < near.count; j++) {
        const key = near.k[j], half = (0.4 + twigs.size[key] * 0.5) * size;
        const px = -near.dx[j] * size, py = -near.dy[j] * size;
        if (px * px + py * py >= (half + 1) * (half + 1)) continue;
        const dirX = twigs.cos[key], dirY = twigs.sin[key];
        const along = clamp(px * dirX + py * dirY, -half, half);
        const d = Math.hypot(px - along * dirX, py - along * dirY), radius = 0.6 + twigs.id[key] * 0.4;
        if (d >= radius) continue;
        const round = Math.sqrt(1 - (d / radius) ** 2);
        const bark = 0.8 + round * 0.3 + (crumbs(u * 3, v) - 0.5) * 0.25;
        lay(1.5 + radius * round * 2, 0.22 * bark, 0.16 * bark, 0.1 * bark, 0.85);
      }
    }
    // pebbles: low domes, 2 to 6 cm across, a little flattened and turned
    {
      const near = pebbles.near(u, v), size = cm(pebbleCells);
      for (let j = 0; j < near.count; j++) {
        const key = near.k[j], radius = 1 + pebbles.size[key] * 2;
        const px = -near.dx[j] * size, py = -near.dy[j] * size;
        if (px * px + py * py >= radius * radius * 1.6) continue;
        const cs = pebbles.cos[key], sn = pebbles.sin[key];
        const qx = (px * cs + py * sn) / 1.25, qy = -px * sn + py * cs;
        const d = Math.hypot(qx, qy);
        if (d >= radius) continue;
        const dome = Math.sqrt(1 - (d / radius) ** 2);
        const grey = (0.28 + pebbles.id[key] * 0.12) * (0.85 + dome * 0.25 + (crumbs(u * 2, v * 2) - 0.5) * 0.2);
        lay(1.2 + dome * radius * 0.75, grey, grey * 0.97, grey * 0.9, 0.6);
      }
    }
    o.h = h; o.r = clamp(r, 0, 1); o.g = clamp(g, 0, 1); o.b = clamp(b, 0, 1); o.rough = rough;
  }, 1 / (2 * FLOOR_CM));
}
