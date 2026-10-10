// Texture arrays for the bark and leaf images (one draw samples any tree type), with coverage-preserving alpha.
import * as THREE from 'three/webgpu';
import { float, select, uint } from 'three/tsl';
import type { Float, Uint } from './types.ts';

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/**
 * Coverage-preserving alpha for alpha-tested foliage: for each mip level (2x2 box filter, as the GPU builds them),
 * the scale that keeps the same fraction of texels above the 0.5 cut-off as the full-size image. Without it a leaf
 * card thins out (or, with a crude boost, thickens) depending on its mip, so a tree's density and brightness jump
 * when its LOD swaps to fewer, bigger cards, and distant canopies speckle.
 */
function coverageScales(px: Uint8ClampedArray, size: number, levels: number): number[] {
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
    const sorted = Float32Array.from(a).sort();
    const q = sorted[Math.min(sorted.length - 1, Math.floor((1 - target) * sorted.length))];
    scales.push(Math.min(8, 0.5 / Math.max(q, 1e-3)));
  }
  return scales;
}

/** Stacks images into one mipmapped DataArrayTexture (so one draw can sample any tree's texture). */
export async function arrayTexture(urls: string[], size: number, fillTransparent = false): Promise<THREE.DataArrayTexture> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D canvas context.');
  const data = new Uint8Array(size * size * 4 * urls.length);
  const imgs = await Promise.all(urls.map(loadImage));
  const alphaScales: number[] = [];
  imgs.forEach((img, i) => {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    if (fillTransparent) {
      // transparent texels are white in these PNGs; mipmapping would bleed that into the leaf edges as a pale halo,
      // so give them the average leaf colour instead
      let r = 0, g = 0, b = 0, n = 0;
      for (let p = 0; p < px.length; p += 4) if (px[p + 3] > 128) { r += px[p]; g += px[p + 1]; b += px[p + 2]; n++; }
      r /= n; g /= n; b /= n;
      for (let p = 0; p < px.length; p += 4) if (px[p + 3] < 128) { px[p] = r; px[p + 1] = g; px[p + 2] = b; }
    }
    if (fillTransparent) alphaScales.push(...coverageScales(px, size, Math.log2(size) + 1));
    data.set(px, i * size * size * 4);
  });
  const tex = new THREE.DataArrayTexture(data, size, size, urls.length);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.userData.alphaScales = alphaScales; // per layer, per mip level
  tex.userData.levels = Math.log2(size) + 1;
  return tex;
}

/** Maps a tree type (uint node) to a texture layer via a select chain. */
export function layerLookup(layers: number[]): (type: Uint) => Float {
  return (type) => {
    let node: Float = float(layers[layers.length - 1]);
    for (let i = layers.length - 2; i >= 0; i--) node = select(type.equal(uint(i)), float(layers[i]), node);
    return node;
  };
}
