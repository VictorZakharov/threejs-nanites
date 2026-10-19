// Texture arrays for the bark and leaf images (one draw samples any tree type), with coverage-preserving alpha.
import * as THREE from 'three/webgpu';
import { float, select, uint } from 'three/tsl';
import type { Float, Uint } from './types.ts';
import type { LayerData, LayerJob } from './texture-pixels.ts';

/** Starts loading one layer in a worker (texture-worker.ts): `url` relative to the page, or 'stone' (stone.ts). */
export function loadLayer(url: string, size: number, leaf = false): Promise<LayerData> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./texture-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<LayerData | { error: string }>) => {
      w.terminate();
      if ('error' in e.data) reject(new Error(e.data.error));
      else resolve(e.data);
    };
    w.onerror = (e) => reject(new Error(e.message));
    const job: LayerJob = { url: url === 'stone' ? url : new URL(url, document.baseURI).href, size, leaf };
    w.postMessage(job);
  });
}

/** Stacks loaded layers (loadLayer) into one mipmapped DataArrayTexture (so one draw can sample any tree's texture). */
export async function arrayTexture(layers: Promise<LayerData>[], size: number): Promise<THREE.DataArrayTexture> {
  const loaded = await Promise.all(layers);
  const data = new Uint8Array(size * size * 4 * loaded.length);
  loaded.forEach((l, i) => data.set(l.px, i * size * size * 4));
  const tex = new THREE.DataArrayTexture(data, size, size, loaded.length);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.userData.alphaScales = loaded.flatMap((l) => l.alphaScales); // per layer, per mip level (leaves)
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
