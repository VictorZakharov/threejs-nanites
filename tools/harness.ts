// Headless test harness for Nanite Forest: boots Vite and a headless Chromium/Edge on the real GPU (WebGPU), flies
// the camera to fixed viewpoints, benchmarks each (pipelined frame time, GPU time from timestamp queries), runs
// probes, and saves screenshots + report.json + the page console to tools/out/. Nothing is shown on screen.
//
//   npm run harness -- --help        every option
//
// The parts: harness/options.ts (command line), harness/views.ts (viewpoints), harness/browser.ts (temp folder,
// server, browser, page), harness/session.ts (boot, per-view run), harness/motion.ts (sweeps, dolly),
// harness/typematch.ts (impostor vs geometry colour per tree type), harness/images.ts (screenshot measures), probes/ (page-side measures, run with --probe).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, parseOptions } from './harness/options.ts';
import { useProjectTemp, startServer, launchBrowser, openPage } from './harness/browser.ts';
import { boot, runViews } from './harness/session.ts';
import { sweeps, dolly } from './harness/motion.ts';
import { typeMatch } from './harness/typematch.ts';
import { status, at } from './harness/status.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'tools', 'out');

const opts = parseOptions(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });
useProjectTemp(root);

const t0 = Date.now();
// watchdog: a stuck or overlong run fails with the step it was in (--timeout seconds)
const watchdog = setTimeout(() => {
  console.error(`HARNESS TIMEOUT after ${opts.timeout}s, at: ${status.step}`);
  process.exit(2);
}, opts.timeout * 1000);
const server = opts.url ? null : await startServer(root); // --url tests a deployed build instead of the source
const url = opts.url ?? server?.url ?? '';
const browser = await launchBrowser();
let exitCode = 0;
try {
  const { page, logs, failed } = await openPage(browser, opts);
  // --ab runs everything once per variant query; without it, once with --query alone
  const variants = opts.variants ?? [null];
  const reports: Record<string, unknown>[] = [];
  for (const [k, variant] of variants.entries()) {
    const query = [opts.query, variant].filter(Boolean).join('&');
    at(`booting ${query || '(no query)'}`);
    const tb = Date.now();
    const info = await boot(page, url, query, opts, outDir);
    console.log(`booted in ${((Date.now() - tb) / 1000).toFixed(1)}s${k === 0 ? ` (${((Date.now() - t0) / 1000).toFixed(1)}s with server + browser)` : ''}`);
    if (k === 0) {
      console.log(JSON.stringify(info, null, 2));
      const expr = opts.evalFile ? readFileSync(opts.evalFile, 'utf8') : opts.eval;
      if (expr) {
        const r: unknown = await page.evaluate(async (src: string) => await (0, eval)(src), expr);
        console.log('eval:', typeof r === 'string' ? r : JSON.stringify(r, null, 2));
      }
    }
    if (variant !== null) console.log(`\n=== variant ${k}: ${variant}`);
    const report: Record<string, unknown> = { info, query, size: `${opts.width}x${opts.height}`, frames: opts.frames, zoom: opts.zoom };
    const tag = variant === null ? '' : `@${k}`;
    report.views = await runViews(page, opts, { root, outDir, tag });
    if (opts.sweep) report.sweeps = await sweeps(page, opts, outDir, tag);
    if (opts.dolly) report.dolly = await dolly(page, opts, outDir, tag);
    if (opts.typematch) report.typematch = await typeMatch(page, opts, outDir);
    reports.push(report);
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  writeFileSync(join(outDir, 'console.log'), logs.join('\n'));
  if (failed()) exitCode = 1;
  console.log(`\nscreenshots + report in ${outDir}  (${((Date.now() - t0) / 1000).toFixed(0)}s in all)`);
} catch (e) {
  console.error('HARNESS ERROR:', e instanceof Error ? e.message : e);
  exitCode = 1;
} finally {
  // shutting down can hang (browser or Vite); the results are written by now, so give it 5 s and exit regardless
  at('shutting down');
  clearTimeout(watchdog);
  const closed = Promise.all([browser.close(), server?.close()]);
  const late = await Promise.race([closed.then(() => false), new Promise((r) => setTimeout(() => r(true), 5000))]);
  if (late) console.log('(browser/server shutdown hung; exiting anyway)');
}
process.exit(exitCode);
