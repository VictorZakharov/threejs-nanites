// The models' stone: a tileable pale marble (warm white, soft clouding, faint grey veins), generated in the texture
// worker (texture-worker.ts) as one more layer of the bark texture array, so it needs no file.
import { makeFbm } from './ground/floor-maps.ts';

/** The marble's RGBA texels, `size` square. */
export function stonePixels(size = 1024): Uint8ClampedArray<ArrayBuffer> {
  const cloud = makeFbm(71, 4, 5), warp = makeFbm(73, 3, 4);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const c = cloud(u, v), w = warp(u, v);
      // veins: thin dark lines along a warped sine (periodic in u and v, so the tile wraps)
      const vein = Math.pow(Math.abs(Math.sin((u + v * 2 + w * 1.6) * Math.PI * 3)), 0.12);
      const k = (0.93 + (c - 0.5) * 0.12) * (0.82 + 0.18 * vein);
      const i = (y * size + x) * 4;
      data[i] = 214 * k; data[i + 1] = 208 * k; data[i + 2] = 196 * k; data[i + 3] = 255;
    }
  }
  return data;
}
