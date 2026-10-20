// Starting things up: the temp folder, the Vite server and a headless browser on the real GPU.
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';

/**
 * Points TEMP/TMP at tools/tmp/browser/run-<pid> (Playwright puts the browser profile in os.tmpdir(), which reads
 * them): never the system temp folder, the C: drive is full. Older runs' folders are removed, best effort (a
 * browser may still be exiting and holding files; they go next time).
 */
export function useProjectTemp(root: string): void {
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
export async function startServer(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await createServer({ root, logLevel: 'silent', server: { port: 5199, strictPort: false } });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('Vite reported no local URL');
  return { url, close: () => server.close() };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.css': 'text/css', '.md': 'text/markdown',
};
const PRECOMPRESSED = new Set(['.png', '.jpg', '.webp', '.mp3']);

/**
 * A built site (`--dist`: dist/ after `npx vite build`) served as GitHub Pages serves it: gzip for everything but
 * images and audio (Pages gzips .nm too), `Cache-Control: max-age=600`. Returns { url, close }.
 */
export async function startStatic(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const gz = new Map<string, Buffer>();
  const server = createHttpServer((req, res) => {
    const path = normalize(join(dir, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)));
    let file = path.startsWith(normalize(dir)) ? path : '';
    try {
      if (file && statSync(file).isDirectory()) file = join(file, 'index.html');
      const ext = extname(file);
      let body: Buffer = readFileSync(file);
      const headers: Record<string, string> = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'max-age=600' };
      if (!PRECOMPRESSED.has(ext) && /gzip/.test(String(req.headers['accept-encoding']))) {
        if (!gz.has(file)) gz.set(file, gzipSync(body, { level: 6 }));
        body = gz.get(file)!;
        headers['Content-Encoding'] = 'gzip';
      }
      headers['Content-Length'] = String(body.length);
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(5299, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:5299/', close: () => new Promise((r) => server.close(() => r())) };
}

function gpuArgs(): string[] {
  // (autoplay: --probe=music starts the track from a synthetic event; nothing else plays sound)
  const a = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=WebGPU', '--autoplay-policy=no-user-gesture-required'];
  if (process.platform === 'win32') a.push('--use-angle=d3d11');
  return a;
}

/** A headless browser with WebGPU: Playwright's Chromium, else the installed Edge, else Chrome. */
export async function launchBrowser(): Promise<Browser> {
  const fails: string[] = [];
  for (const channel of ['chromium', 'msedge', 'chrome']) {
    try {
      return await chromium.launch({ headless: true, channel, args: gpuArgs() });
    } catch (e) {
      fails.push(`${channel}: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`);
    }
  }
  throw new Error('no browser would start:\n  ' + fails.join('\n  '));
}

/**
 * A page that records its console. Errors and warnings are echoed once each (per-frame repeats are deduplicated),
 * everything with `verbose`. Returns { page, logs, failed() } - failed() is true after an uncaught page error.
 */
export async function openPage(
  browser: Browser,
  { width, height, dpr = 1, verbose }: { width: number; height: number; dpr?: number; verbose: boolean },
): Promise<{ page: Page; logs: string[]; failed: () => boolean }> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  const logs: string[] = [];
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
  // (a worker whose script didn't arrive fails with a message-less error: these name the file)
  const netFail = (line: string): void => {
    logs.push(line);
    console.log('  page' + line);
  };
  page.on('requestfailed', (r) => netFail(`[requestfailed] ${r.url()}: ${r.failure()?.errorText ?? '?'}`));
  page.on('response', (r) => {
    if (r.status() >= 400) netFail(`[http ${r.status()}] ${r.url()}`);
  });
  page.on('pageerror', (e) => {
    logs.push('[pageerror] ' + e.message);
    console.log('  [pageerror] ' + e.stack);
    failed = true;
  });
  return { page, logs, failed: () => failed };
}
