// Measuring screenshots (PNG buffers). Shared by the harness and tools/img.mjs.
import { PNG } from 'pngjs';

/** The HUD panel in the top-left corner, left out of every measurement (pixels). */
export const HUD = { w: 480, h: 170 };
const inHud = (x, y) => x < HUD.w && y < HUD.h;

/** Tree-like pixel: clearly green, and not the yellow-green of grass. */
export const isTreePixel = (r, g, b) => g > r * 1.25 && b > r * 0.6;

/**
 * Mean colour of a screenshot, of all pixels and of the tree-like ones, and the share of tree-like pixels.
 * `rect` ({ x, y, w, h }) limits it to part of the image.
 */
export function meanColour(png, rect = null) {
  const p = Buffer.isBuffer(png) ? PNG.sync.read(png) : png;
  const { x: x0 = 0, y: y0 = 0, w = p.width, h = p.height } = rect ?? {};
  const all = [0, 0, 0], tree = [0, 0, 0];
  let n = 0, nt = 0;
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      if (inHud(x, y)) continue;
      const i = (y * p.width + x) * 4, r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      all[0] += r; all[1] += g; all[2] += b; n++;
      if (isTreePixel(r, g, b)) {
        tree[0] += r; tree[1] += g; tree[2] += b; nt++;
      }
    }
  const avg = (c, k) => c.map((v) => +(v / Math.max(k, 1)).toFixed(1));
  return { all: avg(all, n), trees: avg(tree, nt), treeShare: +(nt / Math.max(n, 1)).toFixed(3) };
}

/** Pixels that differ between two screenshots of the same size. */
export function diffPixels(a, b) {
  const p = PNG.sync.read(a), q = PNG.sync.read(b);
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4)
    if (p.data[i] !== q.data[i] || p.data[i + 1] !== q.data[i + 1] || p.data[i + 2] !== q.data[i + 2]) n++;
  return n;
}

export const TILE = 16;

/** Mean luminance per TILE x TILE tile (NaN for tiles under the HUD), plus the decoded image. */
export function tileLuma(buf) {
  const png = PNG.sync.read(buf);
  const tw = Math.floor(png.width / TILE), th = Math.floor(png.height / TILE);
  const luma = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      if (inHud(tx * TILE, ty * TILE)) {
        luma[ty * tw + tx] = NaN;
        continue;
      }
      let sum = 0;
      for (let y = ty * TILE; y < (ty + 1) * TILE; y++)
        for (let x = tx * TILE; x < (tx + 1) * TILE; x++) {
          const i = (y * png.width + x) * 4;
          sum += 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
        }
      luma[ty * tw + tx] = sum / (TILE * TILE);
    }
  return { tw, th, luma, png };
}

/**
 * Heatmap: the image dimmed, each tile tinted red by its score (score >= full gives pure red). Returns PNG bytes.
 */
export function heatmap({ png, tw }, score, full) {
  const out = new PNG({ width: png.width, height: png.height });
  png.data.copy(out.data);
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const t = Math.floor(y / TILE) * tw + Math.floor(x / TILE);
      const a = Math.min(1, (score[t] || 0) / full);
      for (let c = 0; c < 3; c++) out.data[i + c] = png.data[i + c] * 0.45 * (1 - a) + (c === 0 ? 255 : 0) * a;
    }
  return PNG.sync.write(out);
}

/** Part of an image, enlarged `scale` times (nearest neighbour, so pixels stay visible). Returns PNG bytes. */
export function crop(buf, { x, y, w, h }, scale = 4) {
  const p = PNG.sync.read(buf);
  const out = new PNG({ width: w * scale, height: h * scale });
  for (let oy = 0; oy < h * scale; oy++)
    for (let ox = 0; ox < w * scale; ox++) {
      const i = ((y + Math.floor(oy / scale)) * p.width + (x + Math.floor(ox / scale))) * 4;
      p.data.copy(out.data, (oy * w * scale + ox) * 4, i, i + 4);
    }
  return PNG.sync.write(out);
}

/** Hue of an RGB colour in degrees (0..360). */
function hue(r, g, b) {
  const hi = Math.max(r, g, b), d = hi - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = hi === r ? (g - b) / d : hi === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  return (h * 60 + 360) % 360;
}

/**
 * Per-pixel tree type from a `debug=4` screenshot (a flat colour per type, see TYPE_IDS in src/nanite.js): the
 * index of the id with the closest hue (within 30 degrees), or -1 (ground, sky, an edge). Fog and tone mapping
 * shift and wash out the ids, so only the hue of saturated pixels counts.
 */
export function typeMask(png, ids) {
  const p = Buffer.isBuffer(png) ? PNG.sync.read(png) : png;
  const idHues = ids.map(([r, g, b]) => hue(r, g, b));
  const mask = new Int8Array(p.width * p.height).fill(-1);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      if (inHud(x, y)) continue;
      const i = (y * p.width + x) * 4;
      const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      const hi = Math.max(r, g, b);
      if (hi < 40 || (hi - Math.min(r, g, b)) / hi < 0.55) continue;
      const h = hue(r, g, b);
      let best = -1, bd = 30;
      idHues.forEach((ih, k) => {
        const d = Math.min(Math.abs(h - ih), 360 - Math.abs(h - ih));
        if (d < bd) (bd = d), (best = k);
      });
      mask[y * p.width + x] = best;
    }
  return mask;
}

/** Mean colour (sRGB 0..255) and pixel count of each type in `mask`, over the matching pixels of `png`. */
export function typeColours(png, mask, n) {
  const p = Buffer.isBuffer(png) ? PNG.sync.read(png) : png;
  const sum = Array.from({ length: n }, () => [0, 0, 0, 0]);
  for (let j = 0; j < mask.length; j++) {
    const k = mask[j];
    if (k < 0 || k >= n) continue; // (an id colour no type uses: a blend at an edge)
    const s = sum[k];
    s[0] += p.data[j * 4]; s[1] += p.data[j * 4 + 1]; s[2] += p.data[j * 4 + 2]; s[3]++;
  }
  return sum.map(([r, g, b, c]) => ({ rgb: c ? [r / c, g / c, b / c].map((v) => +v.toFixed(1)) : null, pixels: c }));
}
