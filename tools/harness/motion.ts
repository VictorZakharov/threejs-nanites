// Measures of change between frames: popping (sweeps) and flicker while moving (dolly).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWS } from './views.ts';
import { TILE, tileLuma, heatmap } from './images.ts';
import { at } from './status.ts';
import type { Page } from 'playwright-core';
import type { Options } from './options.ts';
import type { Tiles } from './images.ts';
import type { HarnessView } from '../../src/harness-api.ts';

/** Unit vector of a view's horizontal heading (its yaw), in world x/z. */
function heading(view: HarnessView): [number, number] {
  const yaw = ((view.yaw ?? 0) * Math.PI) / 180;
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

/**
 * Sweeps: the camera stays put while one thing that normally follows it moves forward in steps (`what`: lod = the
 * LOD reference point, shadowlod = the shadow casters' LOD reference, shadow = the shadow map's centre). Anything
 * that changes on screen is popping caused by that alone. Counts tiles whose brightness jumps more than 3/255
 * from one step to the next; heatmap of the largest jump per tile in sweep-<what>-<view>.png
 * (with --ab: sweep-<what>-<view>@<k>.png).
 */
export async function sweeps(page: Page, opts: Options, outDir: string, tag = '') {
  const steps = opts.steps ?? 30, step = opts.step ?? 3;
  const result: Record<string, { jumps: number; worst: number; meanStep: number }> = {};
  console.log(`\nsweeps: ${steps} steps of ${step} m (tiles ${TILE}px; a jump = tile brightness change > 3/255 in one step)`);
  for (const name of opts.views) {
    await page.evaluate((v) => window.__demo.setView(v), { ...VIEWS[name], zoom: opts.zoom ?? VIEWS[name].zoom ?? 1 });
    const [fx, fz] = heading(VIEWS[name]);
    for (const what of (opts.sweep ?? []) as ('lod' | 'shadowlod' | 'shadow')[]) {
      let prev: Tiles | null = null, base: Tiles | null = null, jumps = 0, sum = 0;
      let maxJump: Float32Array | null = null;
      for (let k = 0; k < steps; k++) {
        at(`sweep ${what} ${name}: step ${k + 1}/${steps}`);
        const shift: [typeof what, number, number] = [what, fx * k * step, fz * k * step];
        await page.evaluate(([w, x, z]) => window.__demo.setShift(w, x, z), shift);
        await page.evaluate(() => window.__demo.renderOnce());
        const t = tileLuma(await page.screenshot());
        base ??= t;
        maxJump ??= new Float32Array(t.luma.length);
        if (prev) {
          for (let i = 0; i < t.luma.length; i++) {
            const d = Math.abs(t.luma[i] - prev.luma[i]);
            if (!(d >= 0)) continue; // (NaN: under the HUD)
            maxJump[i] = Math.max(maxJump[i], d);
            sum += d;
            if (d > 3) jumps++;
          }
        }
        prev = t;
      }
      await page.evaluate(() => window.__demo.setShift('none', 0, 0));
      if (!base || !maxJump) continue;
      writeFileSync(join(outDir, `sweep-${what}-${name}${tag}.png`), heatmap(base, maxJump, 12));
      const worst = Math.max(...maxJump.filter((v) => v >= 0));
      const mean = sum / (steps - 1) / maxJump.length;
      result[`${name}/${what}`] = { jumps, worst: +worst.toFixed(1), meanStep: +mean.toFixed(3) };
      console.log(`${name.padEnd(12)} ${what.padEnd(10)} jumps ${String(jumps).padStart(5)}  worst ${worst.toFixed(1).padStart(5)}  mean/step ${mean.toFixed(3)}`);
    }
  }
  return result;
}

/**
 * Dolly: the camera moves forward in small real steps. Flicker is a tile that gets brighter and then darker again
 * (or the reverse) over three frames: smooth motion changes a tile steadily over such short steps, so the second
 * difference |L1 - (L0 + L2) / 2| picks out on/off popping. Use small steps (5 cm) or near detail reads as flicker
 * too. Heatmap of the summed score per tile in dolly-<view>.png (with --ab: dolly-<view>@<k>.png).
 */
export async function dolly(page: Page, opts: Options, outDir: string, tag = '') {
  const steps = opts.steps ?? 40, step = opts.step ?? 0.5;
  const result: Record<string, { events: number; mean: number }> = {};
  console.log(`\ndolly: ${steps} steps of ${step} m (tiles ${TILE}px; flicker = second difference > 4/255)`);
  for (const name of opts.views) {
    const v = VIEWS[name];
    const [fx, fz] = heading(v);
    const frames: Tiles[] = [];
    for (let k = 0; k < steps; k++) {
      at(`dolly ${name}: step ${k + 1}/${steps}`);
      const yaw = (v.yaw ?? 0) + k * (opts.turn ?? 0);
      await page.evaluate((vv) => window.__demo.setView(vv), { ...v, zoom: opts.zoom ?? v.zoom ?? 1, x: v.x + fx * k * step, z: v.z + fz * k * step, yaw, agl: (v.agl ?? 2) + k * (opts.rise ?? 0) });
      await page.evaluate(() => window.__demo.renderOnce());
      frames.push(tileLuma(await page.screenshot()));
    }
    const n = frames[0].luma.length;
    const score = new Float32Array(n);
    let events = 0, total = 0;
    // (--rect: only the tiles inside it, e.g. a band of distant forest)
    const tw = frames[0].png.width / TILE | 0, r = opts.rect;
    const inRect = (i: number): boolean => !r || ((i % tw) * TILE >= r[0] && (i % tw) * TILE < r[0] + r[2] && ((i / tw) | 0) * TILE >= r[1] && ((i / tw) | 0) * TILE < r[1] + r[3]);
    for (let k = 1; k < steps - 1; k++)
      for (let i = 0; i < n; i++) {
        if (!inRect(i)) continue;
        const d = Math.abs(frames[k].luma[i] - (frames[k - 1].luma[i] + frames[k + 1].luma[i]) / 2);
        if (!(d >= 0)) continue;
        score[i] += d;
        total += d;
        if (d > 4) events++;
      }
    writeFileSync(join(outDir, `dolly-${name}${tag}.png`), heatmap(frames[0], score, steps * 1.5));
    const mean = total / (steps - 2) / n;
    result[name] = { events, mean: +mean.toFixed(3) };
    console.log(`${name.padEnd(12)} flicker events ${String(events).padStart(6)}   mean ${mean.toFixed(3)}`);
  }
  return result;
}
