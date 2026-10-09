// Measures of change between frames: popping (sweeps) and flicker while moving (dolly).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWS } from './views.mjs';
import { TILE, tileLuma, heatmap } from './images.mjs';

/** Unit vector of a view's horizontal heading (its yaw), in world x/z. */
function heading(view) {
  const yaw = ((view.yaw ?? 0) * Math.PI) / 180;
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

/**
 * Sweeps: the camera stays put while one thing that normally follows it moves forward in steps (`what`: lod = the
 * LOD reference point, shadowlod = the shadow casters' LOD reference, shadow = the shadow map's centre). Anything
 * that changes on screen is popping caused by that alone. Counts tiles whose brightness jumps more than 3/255
 * from one step to the next; heatmap of the largest jump per tile in sweep-<what>-<view>.png.
 */
export async function sweeps(page, opts, outDir) {
  const steps = opts.steps ?? 30, step = opts.step ?? 3;
  const result = {};
  console.log(`\nsweeps: ${steps} steps of ${step} m (tiles ${TILE}px; a jump = tile brightness change > 3/255 in one step)`);
  for (const name of opts.views) {
    await page.evaluate((v) => window.__demo.setView(v), { ...VIEWS[name], zoom: opts.zoom });
    const [fx, fz] = heading(VIEWS[name]);
    for (const what of opts.sweep) {
      let prev = null, base = null, jumps = 0, sum = 0;
      let maxJump = null;
      for (let k = 0; k < steps; k++) {
        await page.evaluate(([w, x, z]) => window.__demo.setShift(w, x, z), [what, fx * k * step, fz * k * step]);
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
      writeFileSync(join(outDir, `sweep-${what}-${name}.png`), heatmap(base, maxJump, 12));
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
 * too. Heatmap of the summed score per tile in dolly-<view>.png.
 */
export async function dolly(page, opts, outDir) {
  const steps = opts.steps ?? 40, step = opts.step ?? 0.5;
  const result = {};
  console.log(`\ndolly: ${steps} steps of ${step} m (tiles ${TILE}px; flicker = second difference > 4/255)`);
  for (const name of opts.views) {
    const v = VIEWS[name];
    const [fx, fz] = heading(v);
    const frames = [];
    for (let k = 0; k < steps; k++) {
      await page.evaluate((vv) => window.__demo.setView(vv), { ...v, zoom: opts.zoom, x: v.x + fx * k * step, z: v.z + fz * k * step });
      await page.evaluate(() => window.__demo.renderOnce());
      frames.push(tileLuma(await page.screenshot()));
    }
    const n = frames[0].luma.length;
    const score = new Float32Array(n);
    let events = 0, total = 0;
    for (let k = 1; k < steps - 1; k++)
      for (let i = 0; i < n; i++) {
        const d = Math.abs(frames[k].luma[i] - (frames[k - 1].luma[i] + frames[k + 1].luma[i]) / 2);
        if (!(d >= 0)) continue;
        score[i] += d;
        total += d;
        if (d > 4) events++;
      }
    writeFileSync(join(outDir, `dolly-${name}.png`), heatmap(frames[0], score, steps * 1.5));
    const mean = total / (steps - 2) / n;
    result[name] = { events, mean: +mean.toFixed(3) };
    console.log(`${name.padEnd(12)} flicker events ${String(events).padStart(6)}   mean ${mean.toFixed(3)}`);
  }
  return result;
}
