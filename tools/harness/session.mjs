// One booted demo page: loading it with a query, and benchmarking / picturing / probing each view.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWS } from './views.mjs';
import { meanColour } from './images.mjs';

/** Loads the demo with this query (on top of ?harness=1) and waits until it's ready. */
export async function boot(page, url, query, opts, outDir) {
  await page.goto(`${url}?harness=1${query ? '&' + query : ''}`);
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
  ['trees', 6, (n, r) => r.instances ?? ''],
  ['shadowTris', 11, (n, r) => r.shadowTris ?? ''],
  ['imposts', 8, (n, r) => r.impostors ?? ''],
  ['occluded', 8, (n, r) => r.occluded ?? ''], // trees drawn neither way: hidden behind nearer ones
  ['occImp', 7, (n, r) => r.occludedImpostors ?? ''], // impostors dropped the same way
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
    const r = await page.evaluate((n) => window.__demo.bench(n), opts.frames);
    results[name] = r;
    console.log(row(COLUMNS.map(([, , f]) => f(name, r))));

    for (const probe of opts.probes) {
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
      console.log(`${''.padEnd(12)} flicker check: ${same ? 'frames identical' : 'FRAMES DIFFER'}`);
      if (!same) shots.forEach((b, i) => writeFileSync(join(outDir, `${name}${tag}-flicker-${i}.png`), b));
    }

    if (opts.shots) {
      await page.evaluate((rr) => window.__demo.renderOnce(rr), r); // (the HUD then shows the benchmark's numbers)
      const shot = await page.screenshot();
      writeFileSync(join(outDir, `${name}${tag}.png`), shot);
      r.colour = meanColour(shot);
      if (tag) console.log(`${''.padEnd(12)} colour all ${r.colour.all.join(',')}  trees ${r.colour.trees.join(',')}  tree share ${r.colour.treeShare}`);
    }
  }
  return results;
}
