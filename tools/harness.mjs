// Headless test harness for Nanite Forest: boots Vite and a headless Chromium/Edge on the real GPU (WebGPU), flies
// the camera to fixed viewpoints, benchmarks each (pipelined frame time, GPU time from timestamp queries), runs
// probes, and saves screenshots + report.json + the page console to tools/out/. Nothing is shown on screen.
//
//   npm run harness -- --help        every option
//
// The parts: harness/options.mjs (command line), harness/views.mjs (viewpoints), harness/browser.mjs (temp folder,
// server, browser, page), harness/session.mjs (boot, per-view run), harness/motion.mjs (sweeps, dolly),
// harness/images.mjs (screenshot measures), probes/ (page-side measures, run with --probe).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, parseOptions } from './harness/options.mjs';
import { useProjectTemp, startServer, launchBrowser, openPage } from './harness/browser.mjs';
import { boot, runViews } from './harness/session.mjs';
import { sweeps, dolly } from './harness/motion.mjs';

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
const server = opts.url ? null : await startServer(root); // --url tests a deployed build instead of the source
const url = opts.url ?? server.url;
const browser = await launchBrowser();
let exitCode = 0;
try {
  const { page, logs, failed } = await openPage(browser, opts);
  // --ab runs everything once per variant query; without it, once with --query alone
  const variants = opts.variants ?? [null];
  const reports = [];
  for (const [k, variant] of variants.entries()) {
    const query = [opts.query, variant].filter(Boolean).join('&');
    const info = await boot(page, url, query, opts, outDir);
    if (k === 0) {
      console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(JSON.stringify(info, null, 2));
      const expr = opts.evalFile ? readFileSync(opts.evalFile, 'utf8') : opts.eval;
      if (expr) {
        const r = await page.evaluate(async (src) => await (0, eval)(src), expr);
        console.log('eval:', typeof r === 'string' ? r : JSON.stringify(r, null, 2));
      }
    }
    if (variant !== null) console.log(`\n=== variant ${k}: ${variant}`);
    const report = { info, query, size: `${opts.width}x${opts.height}`, frames: opts.frames, zoom: opts.zoom };
    const tag = variant === null ? '' : `@${k}`;
    report.views = await runViews(page, opts, { root, outDir, tag });
    if (opts.sweep) report.sweeps = await sweeps(page, opts, outDir, tag);
    if (opts.dolly) report.dolly = await dolly(page, opts, outDir, tag);
    reports.push(report);
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  writeFileSync(join(outDir, 'console.log'), logs.join('\n'));
  if (failed()) exitCode = 1;
  console.log(`\nscreenshots + report in ${outDir}`);
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  exitCode = 1;
} finally {
  await browser.close();
  await server?.close();
}
process.exit(exitCode);
