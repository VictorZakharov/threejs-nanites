// Screenshot tools (for harness output in tools/out/):
//
//   node tools/img.ts mean  <png...> [--rect=x,y,w,h]   mean colour of all pixels and of the tree-like ones
//   node tools/img.ts crop  <in.png> <out.png> x,y,w,h [scale=4]   an enlarged crop (nearest neighbour)
//   node tools/img.ts diff  <a.png> <b.png> [out.png]   pixels that differ (any channel), by more than 8/255, the
//                                                         largest difference; out.png: where (red, the HUD left out)
//   node tools/img.ts zoom  <unzoomed.png> <zoomed.png> <z> [out.png]   the same view through the z x right-mouse zoom
//                                                         (the screen's centre 1/z, tan-space exact): mean colours of both
//                                                         (the zoomed one box-filtered to the crop's size); out.png: side by side
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PNG } from 'pngjs';
import { meanColour, crop, HUD } from './harness/images.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const files = rest.filter((a) => !a.startsWith('--'));
const rectOf = (s: string): { x: number; y: number; w: number; h: number } => {
  const [x, y, w, h] = s.split(',').map(Number);
  return { x, y, w, h };
};

if (cmd === 'mean') {
  const rect = flags.rect ? rectOf(flags.rect) : null;
  for (const f of files) {
    const c = meanColour(readFileSync(f), rect);
    console.log(`${basename(f).padEnd(28)} all ${c.all.join(',').padEnd(18)} trees ${c.trees.join(',').padEnd(18)} tree share ${c.treeShare}`);
  }
} else if (cmd === 'crop') {
  const [src, dst, rect, scale = '4'] = files;
  writeFileSync(dst, crop(readFileSync(src), rectOf(rect), Number(scale)));
  console.log(`wrote ${dst}`);
} else if (cmd === 'diff') {
  const [fa, fb, dst] = files;
  const a = PNG.sync.read(readFileSync(fa)), b = PNG.sync.read(readFileSync(fb));
  let n = 0, big = 0, worst = 0;
  const out = dst ? new PNG({ width: a.width, height: a.height }) : null;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const hud = x >= a.width - HUD.w && y < HUD.h;
      const d = hud ? 0 : Math.max(...[0, 1, 2].map((c) => Math.abs(a.data[i + c] - b.data[i + c])));
      if (d > 0) n++;
      if (d > 8) big++;
      worst = Math.max(worst, d);
      if (out) for (let c = 0; c < 4; c++) out.data[i + c] = c === 3 ? 255 : c === 0 && d > 8 ? 255 : a.data[i + c] * 0.4;
    }
  console.log(`${basename(fa)} vs ${basename(fb)}: ${n} px differ, ${big} by > 8/255, largest ${worst}`);
  if (out) writeFileSync(dst, PNG.sync.write(out));
} else if (cmd === 'zoom') {
  // (the user: "without / with zoom, they are not the same": the far forest vs what it is up close)
  const [fu, fz, zs, dst] = files;
  const u = PNG.sync.read(readFileSync(fu)), zm = PNG.sync.read(readFileSync(fz)), z = Number(zs);
  const w = Math.floor(u.width / z), h = Math.floor(u.height / z), x0 = Math.floor((u.width - w) / 2), y0 = Math.floor((u.height - h) / 2);
  // filtered in linear light, as the screen's pixels add up: averaged in sRGB a speckled texture came out ~4/255
  // darker than its mip (bare ground on the `lone` view), as if the zoom darkened it
  const toLin = (v: number): number => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const toSrgb = (l: number): number => 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
  const small = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = [0, 0, 0];
      let n = 0;
      for (let yy = Math.floor(y * zm.height / h); yy < Math.floor((y + 1) * zm.height / h); yy++)
        for (let xx = Math.floor(x * zm.width / w); xx < Math.floor((x + 1) * zm.width / w); xx++, n++)
          for (let c = 0; c < 3; c++) s[c] += toLin(zm.data[(yy * zm.width + xx) * 4 + c]);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) small.data[i + c] = toSrgb(s[c] / Math.max(n, 1));
      // (alpha 0: under the zoomed shot's HUD, left out of both means; in it, the zoomed shot came out ~4/255 darker)
      small.data[i + 3] = (x + 1) * zm.width / w > zm.width - HUD.w && (y * zm.height) / h < HUD.h ? 0 : 255;
    }
  // (plain means over the pixels outside the zoomed HUD: meanColour's own HUD corner is all of an image this small)
  const mean = (p: PNG, rx: number, ry: number): string => {
    const m = [0, 0, 0];
    let n = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!small.data[(y * w + x) * 4 + 3]) continue;
        n++;
        for (let c = 0; c < 3; c++) m[c] += p.data[((y + ry) * p.width + x + rx) * 4 + c];
      }
    return m.map((v) => (v / n).toFixed(1)).join(',');
  };
  console.log(`unzoomed centre 1/${z}: ${mean(u, x0, y0)}   zoomed, filtered: ${mean(small, 0, 0)}`);
  if (dst) {
    const out = new PNG({ width: zm.width * 2 + 8, height: zm.height });
    out.data.fill(255);
    for (let y = 0; y < zm.height; y++)
      for (let x = 0; x < zm.width; x++) {
        const o = (y * out.width + x) * 4, si = ((y0 + Math.floor(y / z)) * u.width + x0 + Math.floor(x / z)) * 4, zi = (y * zm.width + x) * 4;
        for (let c = 0; c < 4; c++) (out.data[o + c] = u.data[si + c]), (out.data[o + (zm.width + 8) * 4 + c] = zm.data[zi + c]);
      }
    writeFileSync(dst, PNG.sync.write(out));
  }
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
