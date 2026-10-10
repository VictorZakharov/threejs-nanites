// The models' stone: a tileable pale marble (warm white, soft clouding, faint grey veins), drawn once into a canvas
// and handed to the bark texture array as one more layer (a data URL, so it needs no file).
import { makeFbm } from './ground/floor-maps.ts';

export function stoneTextureUrl(size = 1024): string {
  const cloud = makeFbm(71, 4, 5), warp = makeFbm(73, 3, 4);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const c = cloud(u, v), w = warp(u, v);
      // veins: thin dark lines along a warped sine (periodic in u and v, so the tile wraps)
      const vein = Math.pow(Math.abs(Math.sin((u + v * 2 + w * 1.6) * Math.PI * 3)), 0.12);
      const k = (0.93 + (c - 0.5) * 0.12) * (0.82 + 0.18 * vein);
      const i = (y * size + x) * 4;
      img.data[i] = 214 * k; img.data[i + 1] = 208 * k; img.data[i + 2] = 196 * k; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}
