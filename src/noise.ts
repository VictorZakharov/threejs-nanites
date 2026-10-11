// Deterministic noise and the terrain's height, in plain TypeScript (no three.js): shared by the terrain mesh, the
// placement and the planting workers (src/plant-worker.ts).

/** A small seeded random generator (0..1). */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
export function fbm(x: number, y: number, oct: number): number {
  let s = 0, amp = 1, f = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += valueNoise(x * f, y * f) * amp;
    n += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

/** Hermite step of x between a and b (THREE.MathUtils.smoothstep's argument order). */
export function smoothstep(x: number, a: number, b: number): number {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

/** Terrain height in metres at world (x, z). */
export function heightAt(x: number, z: number): number {
  const hills = fbm(x / 420 + 11.3, z / 420 - 7.1, 5) * 70 - 35;
  const ridges = Math.pow(1 - Math.abs(fbm(x / 900 - 3.7, z / 900 + 1.9, 3) * 2 - 1), 3) * 60;
  // keep the middle of the forest gently rolling
  const r = Math.hypot(x, z);
  const flatten = smoothstep(r, 150, 900);
  return hills * (0.35 + 0.65 * flatten) + ridges * flatten;
}
