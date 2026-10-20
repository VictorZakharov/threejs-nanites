// The pixel work behind the texture arrays (textures.ts), plain TypeScript for the texture worker. The alpha
// measures the library takes (coverage scales, leaf masks) are nanite-lib/alpha.ts's.
import type { LeafMask } from './nanite-lib/dag/types.ts';

/** A layer to load: an image's URL (absolute: the worker's base is its script) or 'stone'; leaves get their alpha work. */
export interface LayerJob { url: string; size: number; leaf: boolean }
/** A loaded layer: RGBA texels; for leaves the alpha scale per mip level and the mask (else [] and null). */
export interface LayerData { px: Uint8ClampedArray<ArrayBuffer>; alphaScales: number[]; mask: LeafMask | null }

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
