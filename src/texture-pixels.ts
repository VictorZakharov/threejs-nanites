// The pixel work behind the texture arrays (textures.ts), plain TypeScript for the texture worker.
import type { LeafMask } from './dag-types.ts';

/** A layer to load: an image's URL (absolute: the worker's base is its script) or 'stone'; leaves get their alpha work. */
export interface LayerJob { url: string; size: number; leaf: boolean }
/** A loaded layer: RGBA texels; for leaves the alpha scale per mip level and the mask (else [] and null). */
export interface LayerData { px: Uint8ClampedArray<ArrayBuffer>; alphaScales: number[]; mask: LeafMask | null }

/**
 * The k-th smallest of `a` (where a sort would put it at k; reorders `a`): quickselect. Sorting each level was ~10x
 * slower in a browser's worker (the impostor atlas's coverage: 0.6 s).
 */
export function select(a: Float32Array, k: number): number {
  let lo = 0, hi = a.length - 1;
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i]; a[i] = a[j]; a[j] = t;
        i++; j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/**
 * Coverage-preserving alpha for alpha-tested foliage: for each mip level (2x2 box filter, as the GPU builds them),
 * the scale that keeps the same fraction of texels above the 0.5 cut-off as the full-size image. Without it a leaf
 * card thins out (or, with a crude boost, thickens) depending on its mip, so a tree's density and brightness jump
 * when its LOD swaps to fewer, bigger cards, and distant canopies speckle.
 */
export function coverageScales(px: Uint8ClampedArray, size: number, levels: number): number[] {
  let a = new Float32Array(size * size);
  for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3] / 255;
  let target = 0;
  for (const v of a) if (v > 0.5) target++;
  target /= a.length;
  const scales = [1];
  let w = size;
  for (let l = 1; l < levels; l++) {
    const h = w >> 1;
    const b = new Float32Array(h * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < h; x++)
        b[y * h + x] = (a[2 * y * w + 2 * x] + a[2 * y * w + 2 * x + 1] + a[(2 * y + 1) * w + 2 * x] + a[(2 * y + 1) * w + 2 * x + 1]) / 4;
    a = b;
    w = h;
    // alpha value at the (1 - target) quantile becomes the new 0.5
    const q = select(Float32Array.from(a), Math.min(a.length - 1, Math.floor((1 - target) * a.length)));
    scales.push(Math.min(8, 0.5 / Math.max(q, 1e-3)));
  }
  return scales;
}

/**
 * Transparent texels are white in the leaf PNGs; mipmapping would bleed that into the leaf edges as a pale halo, so
 * they get the average leaf colour instead.
 */
export function fillTransparent(px: Uint8ClampedArray): void {
  let r = 0, g = 0, b = 0, n = 0;
  for (let p = 0; p < px.length; p += 4) if (px[p + 3] > 128) { r += px[p]; g += px[p + 1]; b += px[p + 2]; n++; }
  r /= n; g /= n; b /= n;
  for (let p = 0; p < px.length; p += 4) if (px[p + 3] < 128) { px[p] = r; px[p + 1] = g; px[p + 2] = b; }
}

/**
 * An image's alpha as a `cells` x `cells` mask (each cell the mean alpha of its block, over half: 1), rows from the
 * top as the leaf shader samples them (flipY off): the leaf DAG's coverage counts (dag-coverage.ts).
 */
export function maskOf(px: Uint8ClampedArray, size: number, cells = 64): LeafMask {
  const sum = new Float64Array(cells * cells), n = new Float64Array(cells * cells);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = Math.floor((y * cells) / size) * cells + Math.floor((x * cells) / size);
      sum[c] += px[(y * size + x) * 4 + 3];
      n[c]++;
    }
  return { size: cells, bits: Uint8Array.from(sum, (v, c) => (v / n[c] > 127.5 ? 1 : 0)) };
}
