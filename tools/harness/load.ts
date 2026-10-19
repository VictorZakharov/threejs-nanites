// --load=N: N cold boots (a fresh browser each: empty HTTP cache, no shader cache), the loading log's timeline
// (median per step, seconds since the navigation started) and what was downloaded. --cpu slows the page
// as a phone would be (Chrome DevTools' emulation); the sizes are the gzipped bytes (wireBytes).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser, openPage } from './browser.ts';
import { boot } from './session.ts';
import { at } from './status.ts';
import type { Options } from './options.ts';

interface Resource { name: string; transfer: number; body: number; start: number; end: number }
interface LoadRun { log: { t: number; msg: string }[]; res: Resource[]; html: number; failed: boolean }

/** Applies --cpu (slowdown, Chrome DevTools' emulation) to the page. */
async function throttle(page: Page, opts: Options): Promise<void> {
  if (!opts.cpu) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.cpu });
}

/**
 * The bytes a URL takes over the network with gzip, as a browser asks for it. (The headless browser reads
 * uncompressed sizes in Resource Timing and over CDP, even from GitHub Pages, and its network throttling took
 * uncompressed time: so no --net, and the sizes are fetched here.)
 */
async function wireBytes(url: string): Promise<number> {
  const get = url.startsWith('https:') ? httpsGet : httpGet;
  return new Promise((resolve) => {
    get(url, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      let n = 0;
      res.on('data', (c: Buffer) => (n += c.length));
      res.on('end', () => resolve(n));
    }).on('error', () => resolve(NaN));
  });
}

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface Profile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

/**
 * --profile: the main thread's CPU profile of the boot (saved as tools/out/load.cpuprofile, opens in Chrome's
 * DevTools), and its top functions by self time, and by file. (Started on a page of the same origin first: the
 * profiler stays with the page's process through the navigation.)
 */
function printProfile(p: Profile, outDir: string): void {
  writeFileSync(join(outDir, 'load.cpuprofile'), JSON.stringify(p));
  const self = new Map<number, number>();
  p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000));
  const byFn = new Map<string, number>(), byFile = new Map<string, number>();
  for (const n of p.nodes) {
    const ms = self.get(n.id) ?? 0, f = n.callFrame, file = f.url ? f.url.split('/').pop()!.replace(/-[\w-]{8}\.js$/, '.js') : '(native)';
    const fn = `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`;
    byFn.set(fn, (byFn.get(fn) ?? 0) + ms);
    byFile.set(file, (byFile.get(file) ?? 0) + ms);
  }
  const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log('\nmain thread by file (ms self time; profile in tools/out/load.cpuprofile)');
  for (const [k, v] of top(byFile, 8)) console.log(`  ${String(Math.round(v)).padStart(6)}  ${k}`);
  console.log('main thread, top functions (ms self time)');
  for (const [k, v] of top(byFn, 25)) console.log(`  ${String(Math.round(v)).padStart(6)}  ${k.slice(0, 110)}`);
}

/** One cold boot: its loading log and resource timings (and with `profile`, the main thread's CPU profile). */
async function oneBoot(url: string, query: string, opts: Options, outDir: string, profile: boolean): Promise<LoadRun> {
  const browser: Browser = await launchBrowser();
  try {
    const { page, failed } = await openPage(browser, opts);
    await throttle(page, opts);
    const cdp = profile ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await page.goto(new URL('favicon.ico', url).href).catch(() => null);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
      await cdp.send('Profiler.start');
    }
    // every request, the workers' too (Resource Timing has only the page's own): URL, body size, epoch ms done
    const done: Promise<{ name: string; body: number; endEpoch: number }>[] = [];
    page.on('requestfinished', (req) => {
      const t = req.timing();
      done.push(req.sizes().then((sz) => sz.responseBodySize, () => 0).then((body) => ({ name: req.url(), body, endEpoch: t.startTime + t.responseEnd })));
    });
    await boot(page, url, query, opts, outDir);
    if (cdp) printProfile((await cdp.send('Profiler.stop')).profile as unknown as Profile, outDir);
    const r = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      // (a build from before the loading log was kept: only when it was ready, to the harness's polling)
      const log = window.__demo.loadLog ?? [{ t: performance.now(), msg: 'Ready (this build keeps no loading log: to within 0.25 s)' }];
      return { log, html: nav?.responseEnd ?? 0, origin: performance.timeOrigin };
    });
    // (each URL once: the workers load their script once per worker, from the cache)
    const seen = new Set<string>();
    const res = (await Promise.all(done))
      .filter((e) => e.endEpoch >= r.origin && !e.name.startsWith('data:') && !seen.has(e.name) && seen.add(e.name))
      .map((e) => ({ name: e.name, transfer: 0, body: e.body, start: 0, end: e.endEpoch - r.origin }));
    return { ...r, res, failed: failed() };
  } finally {
    // (closing can hang, as at the harness's end: 5 s, then on regardless)
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]);
  }
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN;
};
/** A log line without its numbers: the same step across boots. */
const stepKey = (msg: string): string => msg.replace(/[\d.,]+/g, '#');
/** A resource's file name without Vite's content hash or the query. */
const shortName = (u: string): string => decodeURIComponent(new URL(u).pathname.split('/').pop() || 'index.html').replace(/-[\w-]{8}(\.\w+)$/, '$1');

/** --load=N for one query: prints the median timeline and the downloads; returns them for report.json. */
export async function measureLoads(url: string, query: string, opts: Options, outDir: string) {
  const runs: LoadRun[] = [];
  for (let i = 0; i < opts.load; i++) {
    at(`load ${i + 1}/${opts.load}`);
    runs.push(await oneBoot(url, query, opts, outDir, opts.profile && i === 0));
  }
  // timeline: each step of the first boot, with the median over the boots of its time and of its gap to the last step
  const first = runs[0].log;
  const steps = first.map((e, k) => {
    const key = stepKey(e.msg);
    const ts = runs.map((r) => r.log.find((x) => stepKey(x.msg) === key)?.t).filter((t): t is number => t !== undefined);
    const gaps = runs.map((r) => {
      const j = r.log.findIndex((x) => stepKey(x.msg) === key);
      return j < 0 ? undefined : r.log[j].t - (j > 0 ? r.log[j - 1].t : 0);
    }).filter((t): t is number => t !== undefined);
    return { step: e.msg, t: median(ts), gap: median(gaps), k };
  });
  console.log(`\nload timeline (median of ${runs.length} cold boot${runs.length > 1 ? 's' : ''}; s since navigation, step = since the line above)`);
  console.log(`  html received ${(median(runs.map((r) => r.html)) / 1000).toFixed(2)}s`);
  for (const s of steps) console.log(`  ${(s.t / 1000).toFixed(2).padStart(6)}s ${('+' + (s.gap / 1000).toFixed(2)).padStart(7)}  ${s.step}`);
  // downloads (first boot's list, median transfer end)
  const wire = await Promise.all(runs[0].res.map((r) => wireBytes(r.name)));
  const res = runs[0].res.map((r, i) => ({
    file: shortName(r.name),
    kB: Math.round(wire[i] / 1024),
    bodykB: Math.round(r.body / 1024),
    endS: median(runs.map((x) => x.res.find((y) => y.name === r.name)?.end ?? NaN).filter((v) => !Number.isNaN(v))) / 1000,
  }));
  res.sort((a, b) => a.endS - b.endS);
  console.log('\ndownloads (kB gzipped / decoded, done at s)');
  for (const r of res) console.log(`  ${r.file.slice(0, 40).padEnd(40)} ${String(r.kB).padStart(7)} ${String(r.bodykB).padStart(7)} ${r.endS.toFixed(2).padStart(7)}s`);
  const total = res.reduce((s, r) => s + r.kB, 0);
  console.log(`  ${'total'.padEnd(40)} ${String(total).padStart(7)} kB`);
  if (runs.some((r) => r.failed)) console.log('  (a page error during a boot: see above)');
  return { steps, downloads: res, totalkB: total };
}
