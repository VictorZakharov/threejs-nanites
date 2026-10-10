// One booted demo page: loading it with a query, and benchmarking / picturing / probing each view.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWS } from './views.mjs';
import { meanColour, diffPixels } from './images.mjs';
import { at } from './status.mjs';

/** Loads the demo with this query (on top of ?harness=1) and waits until it's ready. */
export async function boot(page, url, query, opts, outDir) {
  // (120 s: the dev server's first load after edits can take over the default 30 s)
  await page.goto(`${url}?harness=1${query ? '&' + query : ''}`, { timeout: 120000 });
  if (opts.resizeDuringLoad) {
    // a fullscreen toggle while the demo is still loading
    const [width, height] = opts.resizeDuringLoad;
    await new Promise((r) => setTimeout(r, 1500));
    await page.setViewportSize({ width, height });
  }
  if (opts.loadingShots) {
    for (let i = 0; i < 12 && !(await page.evaluate(() => window.__demo?.ready || window.__demo?.error)); i++) {
      await page.screenshot({ path: join(outDir, `loading-${i}.png`) });
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  await page.waitForFunction(() => window.__demo?.ready || window.__demo?.error, null, { timeout: 300000, polling: 250 });
  const err = await page.evaluate(() => window.__demo.error);
  if (err) throw new Error('page failed to start: ' + err);
  return page.evaluate(() => window.__demo.info());
}

/** A probe's source: tools/probes/<name>.js holds one expression, `async (demo, view) => result`. */
function probeSource(root, name) {
  return readFileSync(join(root, 'tools', 'probes', `${name}.js`), 'utf8');
}

const COLUMNS = [
  ['view', 12, (n) => n],
  ['frame', 7, (n, r) => r.frameMs.toFixed(2)],
  ['gpu', 7, (n, r) => r.gpuRenderMs.toFixed(2)],
  ['cull', 7, (n, r) => r.gpuComputeMs.toFixed(2)],
  ['cpu', 7, (n, r) => r.cpuMs.toFixed(2)],
  ['clusters', 9, (n, r) => r.clusters],
  ['tris', 10, (n, r) => r.tris],
  ['swTris', 10, (n, r) => r.swTris ?? ''], // triangles in software-rasterized clusters (src/nanite/softraster.ts)
  ['trees', 6, (n, r) => r.instances ?? ''],
  ['shadowTris', 11, (n, r) => r.shadowTris ?? ''],
  ['imposts', 8, (n, r) => r.impostors ?? ''],
  ['occluded', 8, (n, r) => r.occluded ?? ''], // trees drawn neither way: hidden behind nearer ones
  ['occImp', 7, (n, r) => r.occludedImpostors ?? ''], // impostors dropped the same way
  ['secs', 5, (n, r) => r.secs ?? ''], // wall time of the benchmark (the harness's own cost)
];
const row = (cells) => cells.map((c, i) => (i === 0 ? String(c).padEnd(COLUMNS[i][1]) : String(c).padStart(COLUMNS[i][1]))).join(' ');

/**
 * Every view: benchmark (numbers printed as a table), probes, the still-frame check and a screenshot. `tag` is
 * added to the file names (A/B variants: "@0", "@1", ...). Returns { view: result }.
 */
export async function runViews(page, opts, { root, outDir, tag = '' }) {
  const results = {};
  console.log('\n' + row(COLUMNS.map((c) => c[0])));
  for (const name of opts.views) {
    const view = { ...VIEWS[name], zoom: opts.zoom ?? VIEWS[name].zoom ?? 1 };
    await page.evaluate((v) => window.__demo.setView(v), view);
    at(`view ${name}: benchmark`);
    const t0 = Date.now();
    const r = await page.evaluate((n) => window.__demo.bench(n), opts.frames);
    r.secs = ((Date.now() - t0) / 1000).toFixed(1);
    results[name] = r;
    console.log(row(COLUMNS.map(([, , f]) => f(name, r))));

    for (const probe of opts.probes) {
      at(`view ${name}: probe ${probe}`);
      const res = await page.evaluate(async ([src, v]) => await (0, eval)(src)(window.__demo, v), [probeSource(root, probe), view]);
      if (res && typeof res.png === 'string') {
        writeFileSync(join(outDir, `${probe}-${name}${tag}.png`), Buffer.from(res.png.split(',')[1], 'base64'));
        delete res.png;
      }
      (r.probes ??= {})[probe] = res;
      console.log(`${''.padEnd(12)} ${probe}: ${JSON.stringify(res)}`);
    }

    if (opts.flicker) {
      // a still camera (run with wind=0) must give identical frames; anything else is nondeterminism
      const shots = [];
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.__demo.renderOnce());
        shots.push(await page.screenshot({ clip: { x: 0, y: 150, width: opts.width, height: opts.height - 150 } }));
      }
      const same = shots.every((b) => b.equals(shots[0]));
      const px = same ? 0 : Math.max(...shots.slice(1).map((b) => diffPixels(shots[0], b)));
      r.flickerPx = px;
      console.log(`${''.padEnd(12)} flicker check: ${same ? 'frames identical' : `FRAMES DIFFER (${px} px)`}`);
      if (!same) shots.forEach((b, i) => writeFileSync(join(outDir, `${name}${tag}-flicker-${i}.png`), b));
    }

    if (opts.shots) {
      at(`view ${name}: screenshot`);
      await page.evaluate((rr) => window.__demo.renderOnce(rr), r); // (the HUD then shows the benchmark's numbers)
      const shot = await page.screenshot();
      writeFileSync(join(outDir, `${name}${tag}.png`), shot);
      r.colour = meanColour(shot);
      if (tag) console.log(`${''.padEnd(12)} colour all ${r.colour.all.join(',')}  trees ${r.colour.trees.join(',')}  tree share ${r.colour.treeShare}`);
    }
  }
  return results;
}
