// Headless test harness: boots Vite + a headless Chromium/Edge with the real GPU (WebGPU), flies the camera to a set
// of fixed viewpoints, benchmarks each (CPU + GPU frame time measured per frame via queue.onSubmittedWorkDone) and
// saves screenshots + a JSON report to tools/out. Nothing is shown on screen.
//
//   npm run harness                       all views, default settings
//   npm run harness -- --views=ground,canopy --frames=200 --query="shadows=0&trees=5000"
//   npm run harness -- --eval="__demo.stats()"   run an expression in the page after load and print it
//   npm run harness -- --eval-file=probe.js   same, from a file
//   npm run harness -- --url=https://victorzakharov.github.io/threejs-nanites/   test the deployed site
//   npm run harness -- --loading-shots      also screenshot the loading screen (tools/out/loading-N.png)
//   npm run harness -- --flicker --query=wind=0   still camera must render identical frames
//   npm run harness -- --sweep=lod,shadowlod,shadow --views=ground --query=wind=0
//        hold the view still and move only the LOD reference / shadow-caster LOD reference / shadow-map centre
//        along the view direction (--steps=30 --step=3 m); reports tiles whose brightness jumps between frames
//        and writes a heatmap to tools/out/sweep-<what>-<view>.png
//   npm run harness -- --no-shots          skip screenshots
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { createServer } from 'vite';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'tools', 'out');
mkdirSync(outDir, { recursive: true });
// Keep the browser profile and every other temp file inside the project (Playwright uses os.tmpdir(), which reads
// these), never in the system temp folder.
const tmpRoot = join(root, 'tools', 'tmp', 'browser');
mkdirSync(tmpRoot, { recursive: true });
for (const old of readdirSync(tmpRoot)) {
  try {
    rmSync(join(tmpRoot, old), { recursive: true, force: true }); // best effort: a browser may still be exiting
  } catch {
    /* removed next run */
  }
}
const tmpDir = join(tmpRoot, `run-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = tmpDir;

// ---- options
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const [W, H] = String(args.size ?? '1600x900').split('x').map(Number);
const frames = Number(args.frames ?? 120);
const query = String(args.query ?? '');

// Viewpoints: x/z in world metres, agl = height above ground (or y absolute), yaw/pitch in degrees.
const VIEWS = {
  ground: { x: 20, z: 40, agl: 1.8, yaw: 30, pitch: 4 },
  closeup: { x: 0, z: 0, agl: 3, yaw: 0, pitch: 10, nearTree: 7 },
  canopy: { x: -50, z: 200, agl: 45, yaw: -20, pitch: -6 },
  overview: { x: 0, z: 700, agl: 260, yaw: 0, pitch: -22 },
  horizon: { x: -300, z: -300, agl: 30, yaw: 135, pitch: -2 },
  high: { x: 120, z: 160, agl: 70, yaw: 200, pitch: -40 },
};
const viewNames = args.views ? String(args.views).split(',') : Object.keys(VIEWS);

const TILE = 16;
/** Mean luminance per TILE x TILE tile of a screenshot (the HUD corner excluded). */
function tileLuma(buf) {
  const png = PNG.sync.read(buf);
  const tw = Math.floor(png.width / TILE), th = Math.floor(png.height / TILE);
  const out = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      let sum = 0;
      for (let y = ty * TILE; y < (ty + 1) * TILE; y++)
        for (let x = tx * TILE; x < (tx + 1) * TILE; x++) {
          const i = (y * png.width + x) * 4;
          sum += 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
        }
      out[ty * tw + tx] = tx * TILE < 380 && ty * TILE < 150 ? NaN : sum / (TILE * TILE);
    }
  return { tw, th, luma: out, png };
}

async function sweeps(page) {
  const steps = Number(args.steps ?? 30), step = Number(args.step ?? 3);
  const result = {};
  console.log(`
sweeps: ${steps} steps of ${step} m (tiles ${TILE}px; a jump = tile brightness change > 3/255 in one step)`);
  for (const name of viewNames) {
    await page.evaluate((v) => window.__demo.setView(v), VIEWS[name]);
    const yaw = ((VIEWS[name].yaw ?? 0) * Math.PI) / 180;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (const what of String(args.sweep).split(',')) {
      let prev = null, maxJump = null, jumps = 0, sumJump = 0, base = null;
      for (let k = 0; k < steps; k++) {
        await page.evaluate(([w, x, z]) => window.__demo.setShift(w, x, z), [what, fx * k * step, fz * k * step]);
        await page.evaluate(() => window.__demo.renderOnce());
        const t = tileLuma(await page.screenshot());
        base ??= t;
        if (prev) {
          maxJump ??= new Float32Array(t.luma.length);
          for (let i = 0; i < t.luma.length; i++) {
            const d = Math.abs(t.luma[i] - prev.luma[i]);
            if (!(d >= 0)) continue;
            maxJump[i] = Math.max(maxJump[i], d);
            sumJump += d;
            if (d > 3) jumps++;
          }
        }
        prev = t;
      }
      await page.evaluate(() => window.__demo.setShift('none', 0, 0));
      // heatmap: frame 0 dimmed, tiles tinted red by their largest single-step jump
      const png = base.png;
      for (let y = 0; y < png.height; y++)
        for (let x = 0; x < png.width; x++) {
          const i = (y * png.width + x) * 4;
          const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
          const j = tx < base.tw && ty < base.th ? maxJump[ty * base.tw + tx] || 0 : 0;
          const a = Math.min(1, j / 12);
          for (let c = 0; c < 3; c++) png.data[i + c] = png.data[i + c] * 0.45 * (1 - a) + (c === 0 ? 255 : 0) * a;
        }
      writeFileSync(join(outDir, `sweep-${what}-${name}.png`), PNG.sync.write(png));
      const worst = Math.max(...maxJump.filter((v) => v >= 0));
      result[`${name}/${what}`] = { jumps, worst: +worst.toFixed(1), meanStep: +(sumJump / (steps - 1) / maxJump.length).toFixed(3) };
      console.log(`${name.padEnd(10)} ${what.padEnd(10)} jumps ${String(jumps).padStart(5)}  worst ${worst.toFixed(1).padStart(5)}  mean/step ${(sumJump / (steps - 1) / maxJump.length).toFixed(3)}`);
    }
  }
  return result;
}

function gpuArgs() {
  const a = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=WebGPU'];
  if (process.platform === 'win32') a.push('--use-angle=d3d11');
  return a;
}

async function launch() {
  const fails = [];
  for (const channel of ['chromium', 'msedge', 'chrome']) {
    try {
      return await chromium.launch({ headless: true, channel, args: gpuArgs() });
    } catch (e) {
      fails.push(`${channel}: ${String(e.message).split('\n')[0]}`);
    }
  }
  throw new Error('no browser would start:\n  ' + fails.join('\n  '));
}

const t0 = Date.now();
// --url=<deployed site> tests a deployed build instead of the local source
const server = args.url ? null : await createServer({ root, logLevel: 'silent', server: { port: 5199, strictPort: false } });
await server?.listen();
const url = args.url ? String(args.url) : server.resolvedUrls.local[0];
const browser = await launch();
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const logs = [];
  const seen = new Map(); // dedupe repeated (per-frame) errors
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    logs.push(line);
    const key = line.slice(0, 160);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) > 1) return;
    if (m.type() === 'error' || m.type() === 'warning' || args.verbose) console.log('  page' + line.slice(0, 1500));
  });
  page.on('pageerror', (e) => {
    logs.push('[pageerror] ' + e.message);
    console.log('  [pageerror] ' + e.stack);
    exitCode = 1;
  });

  await page.goto(`${url}?harness=1${query ? '&' + query : ''}`);
  if (args['loading-shots']) {
    // screenshots of the loading screen while it runs
    for (let i = 0; i < 12 && !(await page.evaluate(() => window.__demo?.ready || window.__demo?.error)); i++) {
      await page.screenshot({ path: join(outDir, `loading-${i}.png`) });
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  await page.waitForFunction(() => window.__demo?.ready || window.__demo?.error, null, { timeout: 300000, polling: 250 });
  const err = await page.evaluate(() => window.__demo.error);
  if (err) throw new Error('page failed to start: ' + err);
  const info = await page.evaluate(() => window.__demo.info());
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(info, null, 2));

  if (args['eval-file']) args.eval = readFileSync(String(args['eval-file']), 'utf8');
  if (args.eval) {
    const r = await page.evaluate(async (src) => await (0, eval)(src), String(args.eval));
    console.log('eval:', typeof r === 'string' ? r : JSON.stringify(r, null, 2));
  }

  const report = { info, query, size: `${W}x${H}`, frames, views: {} };
  console.log(`\n${'view'.padEnd(10)} ${'frame'.padStart(7)} ${'gpu'.padStart(7)} ${'cull'.padStart(7)} ${'cpu'.padStart(7)} ${'clusters'.padStart(9)} ${'tris'.padStart(10)} ${'inst'.padStart(6)} ${'shadowTris'.padStart(11)}`);
  for (const name of viewNames) {
    const view = VIEWS[name];
    if (!view) {
      console.log(`unknown view ${name}`);
      continue;
    }
    await page.evaluate((v) => window.__demo.setView(v), view);
    const r = await page.evaluate((n) => window.__demo.bench(n), frames);
    report.views[name] = r;
    console.log(
      `${name.padEnd(10)} ${r.frameMs.toFixed(2).padStart(7)} ${r.gpuRenderMs.toFixed(2).padStart(7)} ${r.gpuComputeMs.toFixed(2).padStart(7)} ${r.cpuMs.toFixed(2).padStart(7)} ${String(r.clusters).padStart(9)} ${String(r.tris).padStart(10)} ${String(r.instances ?? '').padStart(6)} ${String(r.shadowTris ?? '').padStart(11)}`,
    );
    if (args.flicker) {
      // a still camera (run with wind=0) must give identical frames; anything else is nondeterminism
      const shots = [];
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.__demo.renderOnce());
        shots.push(await page.screenshot({ clip: { x: 0, y: 150, width: W, height: H - 150 } }));
      }
      const same = shots.every((b) => b.equals(shots[0]));
      console.log(`${''.padEnd(10)} flicker check: ${same ? 'frames identical' : 'FRAMES DIFFER'}`);
      if (!same) shots.forEach((b, i) => writeFileSync(join(outDir, `${name}-flicker-${i}.png`), b));
    }
    if (!args['no-shots']) {
      await page.evaluate((r) => window.__demo.renderOnce(r), r);
      await page.screenshot({ path: join(outDir, `${name}.png`) });
    }
  }
  if (args.sweep) report.sweeps = await sweeps(page);
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'console.log'), logs.join('\n'));
  console.log(`\nscreenshots + report in ${outDir}`);
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  exitCode = 1;
} finally {
  await browser.close();
  await server?.close();
}
process.exit(exitCode);
