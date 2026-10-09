// Screenshot tools (for harness output in tools/out/):
//
//   node tools/img.mjs mean  <png...> [--rect=x,y,w,h]   mean colour of all pixels and of the tree-like ones
//   node tools/img.mjs crop  <in.png> <out.png> x,y,w,h [scale=4]   an enlarged crop (nearest neighbour)
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { meanColour, crop } from './harness/images.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const files = rest.filter((a) => !a.startsWith('--'));
const rectOf = (s) => {
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
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
