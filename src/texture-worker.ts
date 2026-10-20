// One layer of a texture array (textures.ts) off the main thread: an image fetched, decoded and drawn at the array's
// size (as a canvas on the page did), or the models' marble (stone.ts); for leaves also the coverage-preserving alpha
// scales and the alpha mask the leaf DAG counts coverage with. All layers load in parallel from the top of loading.
import { fillTransparent } from './texture-pixels.ts';
// (straight from the module, not the library's index: a worker's bundle takes only what it imports)
import { coverageScales, maskOf } from './nanite-lib/alpha.ts';
import { stonePixels } from './stone.ts';
import type { LayerJob, LayerData } from './texture-pixels.ts';

self.onmessage = async (e: MessageEvent<LayerJob>) => {
  const { url, size, leaf } = e.data;
  const post = (msg: LayerData | { error: string }, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    let px: Uint8ClampedArray<ArrayBuffer>;
    if (url === 'stone') px = stonePixels(size);
    else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const img = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('No 2D canvas context in a worker.');
      ctx.drawImage(img, 0, 0, size, size);
      px = ctx.getImageData(0, 0, size, size).data;
    }
    const out: LayerData = { px, alphaScales: [], mask: null };
    if (leaf) {
      out.mask = maskOf(px, size); // (alpha only: before the fill, which changes the colour)
      fillTransparent(px);
      out.alphaScales = coverageScales(px, size, Math.log2(size) + 1);
    }
    post(out, [px.buffer]);
  } catch (err) {
    post({ error: String(err instanceof Error ? err.message : err) });
  }
};
