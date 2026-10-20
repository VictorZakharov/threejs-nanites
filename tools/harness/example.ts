// --example[=name]: the library's example page (examples/<name>.html, default gltf) instead of the demo: waits until
// it has drawn `--frames` frames, prints its stats line (the counters the renderer read back), saves
// tools/out/example-<name>.png and the page console. The example sets window.__example = { frames, info() }.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { Options } from './options.ts';
import { at } from './status.ts';

export async function runExample(page: Page, url: string, name: string, opts: Options, outDir: string): Promise<{ info: string; png: string }> {
  at(`example ${name}`);
  await page.goto(new URL(`examples/${name}.html`, url.endsWith('/') ? url : `${url}/`).href);
  const frames = opts.frames;
  // (the info line is written every half second: wait for a frame count past `frames`, then one more update)
  await page.waitForFunction((n) => ((window as unknown as { __example?: { frames: number } }).__example?.frames ?? 0) >= n, frames, { timeout: 60000, polling: 200 });
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => document.getElementById('info')?.textContent ?? '');
  const png = join(outDir, `example-${name}.png`);
  writeFileSync(png, await page.screenshot());
  return { info, png };
}
