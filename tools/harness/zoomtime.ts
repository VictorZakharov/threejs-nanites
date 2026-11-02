// --zoomtime: what changes on screen in the seconds after zooming in, with the page's own loop and auto quality (the
// user: "shadows visibly changing 1-2 sec after zoom"). Per view: 5 s unzoomed to settle, then the 5x zoom; a
// screenshot at each mark, the pixels changed since the last one, by more than 8/255 in brackets (after the zoom has
// eased, ~0.7 s, nothing should change but the wind, the clouds and TAA's jitter: use wind=0&taa=0, and auto=0 to hold
// the setting), and tau / resolution scale / shadow map size every 250 ms.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWS } from './views.ts';
import { diffPixels, tileLuma } from './images.ts';
import { at } from './status.ts';
import type { Page } from 'playwright-core';
import type { Options } from './options.ts';

const MARKS = [0, 700, 900, 1100, 1300, 1500, 1750, 2000, 2500, 3000, 4000, 6000]; // ms after the zoom starts (0: just before)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function zoomTime(page: Page, opts: Options, outDir: string, tag = '') {
  const result: Record<string, { changed: Record<number, string>; track: string }> = {};
  console.log(`
zoomtime: the page's loop, auto quality on; 5 s unzoomed, then the zoom (pixels changed since the last shot)`);
  for (const name of opts.views) {
    at(`zoomtime ${name}`);
    await page.evaluate((v) => window.__demo.setView(v), { ...VIEWS[name], zoom: 1 });
    await page.evaluate(() => window.__demo.live(true));
    await sleep(5000);
    const t0 = Date.now(), changed: Record<number, string> = {};
    let last: Buffer | null = null;
    for (const m of MARKS) {
      await sleep(Math.max(0, m - (Date.now() - t0)));
      const shot = await page.screenshot();
      writeFileSync(join(outDir, `zoomtime-${name}${tag}-${m}.png`), shot);
      if (last && m > 700) {
        // (and the 16 px tiles whose mean moved over 2/255: TAA's jitter averages out in them, a redraw doesn't)
        const [x, y] = [tileLuma(last).luma, tileLuma(shot).luma];
        let tiles = 0;
        for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 2) tiles++;
        changed[m] = `${diffPixels(last, shot)} (${diffPixels(last, shot, 8)}) t${tiles}`;
      }
      last = shot;
      if (m === 0) await page.evaluate(() => void (window.__demo.controls.zoomTarget = window.__demo.controls.zoomMax));
    }
    const log = await page.evaluate(() => window.__demo.live(false));
    await page.evaluate(() => void (window.__demo.controls.zoomTarget = window.__demo.controls.zoom = 1));
    // (tau / scale / shadow map / zoom every 250 ms from 1 s before the zoom: the loop started 5 s before it)
    const track: string[] = [];
    for (let t = 4000, k = 0; t < (log.at(-1)?.[0] ?? 0); t += 250) {
      while (k < log.length - 1 && log[k][0] < t) k++;
      const [, tau, scale, smap, zoom, , , gpu] = log[k];
      track.push(`${tau}/${scale}/${smap}/${gpu}${zoom > 1.01 ? 'z' : ''}`);
    }
    result[name] = { changed, track: track.join(' ') };
    console.log(`${name.padEnd(12)} changed px ${Object.entries(changed).map(([m, n]) => `${m}ms ${n}`).join(', ')}`);
    console.log(`${''.padEnd(12)} tau/scale/smap/GPU ms every 250 ms (z: zoomed): ${track.join(' ')}`);
  }
  return result;
}

/** --flytime=keys: from each view, 2 s still, then those keys held for 6 s with the page's loop and auto quality. */
export async function flyTime(page: Page, opts: Options, outDir: string, tag = '') {
  const keys = opts.flytime ?? [], result: Record<string, { extentSteps: number; track: string }> = {};
  console.log(`
flytime: the page's loop, auto quality on; 2 s still, then ${keys.join('+')} for 6 s`);
  for (const name of opts.views) {
    at(`flytime ${name}`);
    await page.evaluate((v) => window.__demo.setView(v), { ...VIEWS[name], zoom: 1 });
    await page.evaluate(() => window.__demo.live(true));
    await sleep(2000);
    await page.evaluate((ks) => ks.forEach((k) => window.__demo.controls.keys.add(k)), keys);
    const t0 = Date.now();
    for (let m = 0; m <= 6000; m += 500) {
      await sleep(Math.max(0, m - (Date.now() - t0)));
      writeFileSync(join(outDir, `flytime-${name}${tag}-${m}.png`), await page.screenshot());
    }
    await page.evaluate(() => window.__demo.controls.keys.clear());
    const log = await page.evaluate(() => window.__demo.live(false));
    // the shadow map's half-extent: how often it stepped in flight (each step changes every shadow's sharpness)
    let steps = 0;
    for (let k = 1; k < log.length; k++) if (log[k][5] !== log[k - 1][5]) steps++;
    const track: string[] = [];
    for (let t = 1500, k = 0; t < (log.at(-1)?.[0] ?? 0); t += 250) {
      while (k < log.length - 1 && log[k][0] < t) k++;
      const [, tau, scale, smap, , half, y] = log[k];
      track.push(`${tau}/${scale}/${smap}/${half}m@${y}`);
    }
    result[name] = { extentSteps: steps, track: track.join(' ') };
    console.log(`${name.padEnd(12)} shadow extent steps: ${steps} in ${log.length} frames`);
    console.log(`${''.padEnd(12)} tau/scale/smap/half-extent@height every 250 ms: ${track.join(' ')}`);
  }
  return result;
}
