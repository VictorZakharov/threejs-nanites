// The library's boundary (issue #17): nothing in src/nanite-lib/ imports from outside it but three and meshoptimizer,
// so another project can take the folder as it is. Part of `npm run typecheck` (and so of the build).
//
//   node tools/check-lib.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'nanite-lib');
const PACKAGES = ['three/webgpu', 'three/tsl', 'meshoptimizer'];

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

const bad: string[] = [];
for (const f of files(LIB)) {
  const src = readFileSync(f, 'utf8');
  // static and dynamic imports, re-exports, and workers' new URL('...', import.meta.url)
  const specs = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|new URL\(\s*)'([^']+)'/g)].map((m) => m[1]);
  for (const s of specs) {
    const ok = s.startsWith('.') ? !relative(LIB, resolve(dirname(f), s)).startsWith('..') : PACKAGES.includes(s);
    if (!ok) bad.push(`${relative(LIB, f).split(sep).join('/')}: '${s}'`);
  }
}
if (bad.length) {
  console.error(`src/nanite-lib/ imports from outside it (only ${PACKAGES.join(', ')} and its own files):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
