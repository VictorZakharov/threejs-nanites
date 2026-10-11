// Screenshot tools (for harness output in tools/out/):
//
//   node tools/img.ts mean  <png...> [--rect=x,y,w,h]   mean colour of all pixels and of the tree-like ones
//   node tools/img.ts crop  <in.png> <out.png> x,y,w,h [scale=4]   an enlarged crop (nearest neighbour)
//   node tools/img.ts diff  <a.png> <b.png> [out.png]   pixels that differ (any channel), by more than 8/255, the
//                                                         largest difference; out.png: where (red, the HUD left out)
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
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
