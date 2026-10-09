// Starting things up: the temp folder, the Vite server and a headless browser on the real GPU.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Points TEMP/TMP at tools/tmp/browser/run-<pid> (Playwright puts the browser profile in os.tmpdir(), which reads
 * them): never the system temp folder, the C: drive is full. Older runs' folders are removed, best effort (a
 * browser may still be exiting and holding files; they go next time).
 */
export function useProjectTemp(root) {
  const tmpRoot = join(root, 'tools', 'tmp', 'browser');
  mkdirSync(tmpRoot, { recursive: true });
  for (const old of readdirSync(tmpRoot)) {
    try {
      rmSync(join(tmpRoot, old), { recursive: true, force: true });
    } catch {
      /* removed next run */
    }
  }
  const dir = join(tmpRoot, `run-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = dir;
}

/** Vite on the project source (silent). Returns { url, close }. */
export async function startServer(root) {
  const server = await createServer({ root, logLevel: 'silent', server: { port: 5199, strictPort: false } });
  await server.listen();
  return { url: server.resolvedUrls.local[0], close: () => server.close() };
}

function gpuArgs() {
  const a = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=WebGPU'];
  if (process.platform === 'win32') a.push('--use-angle=d3d11');
  return a;
}

/** A headless browser with WebGPU: Playwright's Chromium, else the installed Edge, else Chrome. */
export async function launchBrowser() {
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

/**
 * A page that records its console. Errors and warnings are echoed once each (per-frame repeats are deduplicated),
 * everything with `verbose`. Returns { page, logs, failed() } - failed() is true after an uncaught page error.
 */
export async function openPage(browser, { width, height, verbose }) {
  const page = await browser.newPage({ viewport: { width, height } });
  const logs = [];
  const seen = new Set();
  let failed = false;
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    logs.push(line);
    const key = line.slice(0, 160);
    if (seen.has(key)) return;
    seen.add(key);
    if (m.type() === 'error' || m.type() === 'warning' || verbose) console.log('  page' + line.slice(0, 1500));
  });
  page.on('pageerror', (e) => {
    logs.push('[pageerror] ' + e.message);
    console.log('  [pageerror] ' + e.stack);
    failed = true;
  });
  return { page, logs, failed: () => failed };
}
