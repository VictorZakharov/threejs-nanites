// --lodcheck: does the quality cut still draw the same model? The reference is the model actually drawn at high detail:
// the middle of the view, same camera, through a narrower field of view (--lodk x the zoom, impostors off, a pixel error
// of TRUTH_TAU / lodk of the final image), shrunk as many times in linear light. Against it, the normal view's middle at each
// tau, with its LOD and impostors. Per model on screen (the reference's connected pixels, binned by height):
//   lost / added  coverage it lost or gained, % of its area (wings cut off, or grown): each mask is the debug=4 type
//                 colour over PASSES single frames (no jitter), so a dithered impostor counts by its coverage, both
//                 blurred 3x3 (one sample a pixel against a shrunk reference: otherwise every edge pixel counts)
//   luma          mean sRGB luma difference (cut - reference) where both cover, from frames TAA has settled
// A line is marked FAIL over the limits. lodcheck-<view>-z<zoom>-t<tau>.png: reference | cut | red lost, blue added.
// A reference or cut at the cluster lists' cap is missing clusters: the line says `CAP`, don't trust it (a higher
// --lodk: the reference sees less).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { VIEWS } from './views.ts';
import { typeMask, HUD } from './images.ts';
import { at } from './status.ts';
import type { Page } from 'playwright-core';
import type { Options } from './options.ts';

// keep in sync with TYPE_IDS in src/nanite-lib/gpu/shading.ts
const TYPE_IDS = Array.from({ length: 10 }, (_, i) => { const h = i * 36, f = (n: number): number => Math.max(0, Math.min(1, Math.abs(((h / 60 + n) % 6) - 3) - 1)); return [f(0), f(4), f(2)]; });
const TRUTH_TAU = 4; // (its px error: under a pixel once shrunk; lower runs into the 1M cluster cap on Lucy's field)
const PASSES = 8; // single frames per mask
const SETTLE = 32; // frames for TAA to settle before a colour shot
const CLUSTER_CAP = 1048576;
const BINS = [8, 16, 32, 64, 128, Infinity]; // model height on screen, px: bins' upper ends
const LIMIT = { shape: 15, luma: 4 }; // % of a model's area; sRGB levels
const PAD = 2; // px round a model that count as its own (where it gained coverage)

interface Shot { w: number; h: number; cover: Float32Array; rgb: Float32Array; clusters: number; fov: number }

const toLinear = (c: number): number => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (l: number): number => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055) * 255;
const lumaOf = (rgb: Float32Array, i: number): number => 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];

/** The view at (zoom, tau, impostor px): the model's coverage over PASSES frames and the settled colours (linear). */
async function capture(page: Page, view: string, type: number, zoom: number, tau: number, imppx: number, spread: number): Promise<Shot> {
  await page.evaluate((v) => window.__demo.setView(v), { ...VIEWS[view], zoom });
  await page.evaluate(async ([t, px]) => {
    const d = window.__demo;
    d.forest.u.tau.value = t;
    d.forest.u.impostorPx.value = px;
    d.forest.u.debug.value = 4;
    d.taa.spread = 0;
    for (let i = 0; i < 16; i++) await d.renderOnce(); // (occlusion needs a frame of history)
  }, [tau, imppx]);
  let cover: Float32Array | null = null, w = 0, h = 0;
  for (let i = 0; i < PASSES; i++) {
    await page.evaluate(async () => {
      const d = window.__demo;
      d.taa.reset = true;
      await d.renderFrame();
    });
    const png = PNG.sync.read(await page.screenshot());
    const mask = typeMask(png, TYPE_IDS);
    (w = png.width), (h = png.height);
    cover ??= new Float32Array(w * h);
    for (let j = 0; j < mask.length; j++) if (mask[j] === type) cover[j] += 1 / PASSES;
  }
  const info = await page.evaluate(async ([settle, sp]) => {
    const d = window.__demo;
    d.forest.u.debug.value = 0;
    d.taa.spread = sp;
    d.taa.reset = true;
    for (let i = 0; i < settle; i++) await d.renderFrame();
    const s = await d.stats();
    return { clusters: s.barkClusters + s.leafClusters, fov: d.camera.fov };
  }, [SETTLE, spread]);
  const png = PNG.sync.read(await page.screenshot());
  const rgb = new Float32Array(w * h * 3);
  for (let j = 0; j < w * h; j++) for (let c = 0; c < 3; c++) rgb[j * 3 + c] = toLinear(png.data[j * 4 + c]);
  return { w, h, cover: cover!, rgb, ...info };
}

/** The middle of `s` shrunk by `k` to w x h (box filter, linear light). */
function shrink(s: Shot, k: number, w: number, h: number): Pick<Shot, 'w' | 'h' | 'cover' | 'rgb'> {
  const cover = new Float32Array(w * h), rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(s.w / 2 + (x - w / 2) * k), x1 = Math.max(x0 + 1, Math.floor(s.w / 2 + (x + 1 - w / 2) * k));
      const y0 = Math.floor(s.h / 2 + (y - h / 2) * k), y1 = Math.max(y0 + 1, Math.floor(s.h / 2 + (y + 1 - h / 2) * k));
      let n = 0;
      const o = y * w + x;
      for (let sy = Math.max(0, y0); sy < Math.min(s.h, y1); sy++)
        for (let sx = Math.max(0, x0); sx < Math.min(s.w, x1); sx++) {
          const i = sy * s.w + sx;
          cover[o] += s.cover[i];
          for (let c = 0; c < 3; c++) rgb[o * 3 + c] += s.rgb[i * 3 + c];
          n++;
        }
      if (!n) continue;
      cover[o] /= n;
      for (let c = 0; c < 3; c++) rgb[o * 3 + c] /= n;
    }
  return { w, h, cover, rgb };
}

/** The window w x h in the middle of `s` (no scaling). */
function middle(s: Shot, w: number, h: number): Pick<Shot, 'w' | 'h' | 'cover' | 'rgb'> {
  const x0 = Math.floor((s.w - w) / 2), y0 = Math.floor((s.h - h) / 2);
  const cover = new Float32Array(w * h), rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y + y0) * s.w + x + x0, o = y * w + x;
      cover[o] = s.cover[i];
      for (let c = 0; c < 3; c++) rgb[o * 3 + c] = s.rgb[i * 3 + c];
    }
  return { w, h, cover, rgb };
}

/** Each pixel's model (the reference's connected pixels, those within PAD of one too), -1 for none; their heights. */
function models(cover: Float32Array, w: number, h: number): { of: Int32Array; heights: number[]; touchesEdge: boolean[] } {
  const of = new Int32Array(w * h).fill(-1), heights: number[] = [], touchesEdge: boolean[] = [];
  for (let start = 0; start < w * h; start++) {
    if (of[start] >= 0 || cover[start] <= 0.5) continue;
    const id = heights.length, stack = [start];
    of[start] = id;
    let lo = h, hi = 0, edge = false;
    while (stack.length) {
      const p = stack.pop()!, x = p % w, y = (p - x) / w;
      (lo = Math.min(lo, y)), (hi = Math.max(hi, y));
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const q = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && of[q] < 0 && cover[q] > 0.5) (of[q] = id), stack.push(q);
      }
    }
    heights.push(hi - lo + 1);
    touchesEdge.push(edge);
  }
  const grown = of.slice();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (of[y * w + x] < 0) continue;
      for (let dy = -PAD; dy <= PAD; dy++)
        for (let dx = -PAD; dx <= PAD; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && grown[ny * w + nx] < 0) grown[ny * w + nx] = of[y * w + x];
        }
    }
  return { of: grown, heights, touchesEdge };
}

type Part = Pick<Shot, 'w' | 'h' | 'cover' | 'rgb'>;

/** 3x3 box blur of a coverage mask. */
function blur(a: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) (s += a[ny * w + nx]), n++;
        }
      out[y * w + x] = s / n;
    }
  return out;
}

/**
 * Per height bin: models, lost / added % of their area, the worst model's, luma difference where both cover. `hidden`:
 * the window's top right corner the reference's HUD covers (x from, y to): models touching it aren't counted.
 */
function compare(ref: Part, cut: Part, hidden: { x: number; y: number }) {
  const { of, heights, touchesEdge } = models(ref.cover, ref.w, ref.h);
  const rb = blur(ref.cover, ref.w, ref.h), cb = blur(cut.cover, ref.w, ref.h);
  const m = heights.map((height, id) => ({ height, edge: touchesEdge[id], area: 0, lost: 0, added: 0, dl: 0, n: 0 }));
  for (let i = 0; i < of.length; i++) {
    const id = of[i];
    if (id < 0) continue;
    const r = rb[i], c = cb[i], s = m[id];
    if (i % ref.w >= hidden.x && Math.floor(i / ref.w) < hidden.y) s.edge = true;
    s.area += r;
    s.lost += Math.max(0, r - c);
    s.added += Math.max(0, c - r);
    if (ref.cover[i] > 0.5 && cut.cover[i] > 0.5) (s.dl += toSrgb(lumaOf(cut.rgb, i)) - toSrgb(lumaOf(ref.rgb, i))), s.n++;
  }
  const whole = m.filter((s) => !s.edge && s.area >= 4);
  return BINS.map((top, b) => {
    const low = b ? BINS[b - 1] : 0, l = whole.filter((s) => s.height > low && s.height <= top);
    if (!l.length) return null;
    const area = l.reduce((a, s) => a + s.area, 0), n = l.reduce((a, s) => a + s.n, 0);
    const pct = (k: 'lost' | 'added'): number => (100 * l.reduce((a, s) => a + s[k], 0)) / area;
    return {
      px: top === Infinity ? `>${low}` : `${low + 1}-${top}`, models: l.length,
      lost: +pct('lost').toFixed(1), added: +pct('added').toFixed(1),
      worstLost: +Math.max(...l.map((s) => (100 * s.lost) / s.area)).toFixed(0),
      luma: +(l.reduce((a, s) => a + s.dl, 0) / Math.max(n, 1)).toFixed(1),
    };
  }).filter((x) => x !== null);
}

/** reference | cut | where they differ (red lost, blue added), each `scale` x. */
function sheet(ref: Part, cut: Part, scale = 3): Buffer {
  const { w, h } = ref, gap = 4, out = new PNG({ width: (w * 3 + gap * 2) * scale, height: h * scale });
  const put = (ox: number, oy: number, r: number, g: number, b: number): void => {
    for (let y = 0; y < scale; y++)
      for (let x = 0; x < scale; x++) {
        const o = ((oy * scale + y) * out.width + ox * scale + x) * 4;
        (out.data[o] = r), (out.data[o + 1] = g), (out.data[o + 2] = b), (out.data[o + 3] = 255);
      }
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const col = (p: Part): number[] => [0, 1, 2].map((c) => toSrgb(p.rgb[i * 3 + c]));
      const [a, b] = [col(ref), col(cut)];
      put(x, y, a[0], a[1], a[2]);
      put(x + w + gap, y, b[0], b[1], b[2]);
      const lost = Math.max(0, ref.cover[i] - cut.cover[i]), added = Math.max(0, cut.cover[i] - ref.cover[i]), g = 60 + ref.cover[i] * 60;
      put(x + (w + gap) * 2, y, g + lost * 135, g * (1 - lost - added), g + added * 135);
    }
  return PNG.sync.write(out);
}

export async function lodCheck(page: Page, opts: Options, outDir: string, taus: number[]) {
  const names = await page.evaluate(() => window.__demo.info().types.map((t) => t.name));
  const type = names.findIndex((n) => new RegExp(opts.lodtype, 'i').test(n));
  if (type < 0) throw new Error(`--lodtype=${opts.lodtype}: none of ${names.join(', ')}`);
  const [tau0, imppx, spread] = await page.evaluate(() => [window.__demo.forest.u.tau.value, window.__demo.forest.u.impostorPx.value, window.__demo.taa.spread]);
  const result: Record<string, unknown> = {};
  const pad = (v: unknown, n: number): string => String(v).padStart(n);
  console.log(`\nlodcheck: ${names[type]}, the cut vs itself drawn at ${opts.lodk}x the zoom (tau ${TRUTH_TAU}, no impostors), shrunk; limits ${LIMIT.shape}% of its area, ${LIMIT.luma}/255`);
  for (const view of opts.views) {
    const zoom = opts.zoom ?? VIEWS[view].zoom ?? 1;
    at(`lodcheck ${view}: reference`);
    const truth = await capture(page, view, type, zoom * opts.lodk, TRUTH_TAU, 0, spread);
    for (const tau of taus) {
      at(`lodcheck ${view}: tau ${tau}`);
      const shot = await capture(page, view, type, zoom, tau, imppx, spread);
      const k = Math.tan((shot.fov * Math.PI) / 360) / Math.tan((truth.fov * Math.PI) / 360);
      const w = Math.floor(shot.w / k), h = Math.floor(shot.h / k);
      const ref = shrink(truth, k, w, h), cut = middle(shot, w, h);
      writeFileSync(join(outDir, `lodcheck-${view}-z${zoom}-t${tau}.png`), sheet(ref, cut));
      const hidden = { x: (truth.w - HUD.w - truth.w / 2) / k + w / 2, y: (HUD.h - truth.h / 2) / k + h / 2 };
      const bins = compare(ref, cut, hidden), capped = Math.max(truth.clusters, shot.clusters) >= CLUSTER_CAP;
      console.log(`  ${view} zoom ${zoom} tau ${tau}: ${shot.clusters} clusters${capped ? ' CAP' : ''}`);
      console.log(`    ${'px tall'.padEnd(8)}${pad('models', 7)}${pad('lost%', 7)}${pad('added%', 7)}${pad('worst', 7)}${pad('luma', 7)}`);
      for (const b of bins) {
        const fail = b.lost > LIMIT.shape || b.added > LIMIT.shape || Math.abs(b.luma) > LIMIT.luma;
        console.log(`    ${b.px.padEnd(8)}${pad(b.models, 7)}${pad(b.lost, 7)}${pad(b.added, 7)}${pad(b.worstLost, 7)}${pad(b.luma, 7)}${fail ? '  FAIL' : ''}`);
      }
      result[`${view}/z${zoom}/t${tau}`] = { capped, clusters: shot.clusters, truthClusters: truth.clusters, bins };
    }
  }
  await page.evaluate(([t, px, sp]) => {
    const d = window.__demo;
    d.forest.u.tau.value = t;
    d.forest.u.impostorPx.value = px;
    d.forest.u.debug.value = 0;
    d.taa.spread = sp;
  }, [tau0, imppx, spread]);
  return result;
}
