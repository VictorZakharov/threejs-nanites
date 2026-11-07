// Whether the leaves' depth prepass pays (src/nanite-lib/gpu/prepass.ts) depends on the GPU: its switch by leaf density was
// set on the dev GPU, and the AMD reference PC's iGPU saved 6.4 ms of 46 with it on where the switch said off (1080p,
// `amdground`). So auto quality times it both ways on the device: once settled, it flips the prepass for a few seconds and
// keeps the faster, moving the density it switches at so this density lands on that side. Again when the density has moved
// by a third since the last trial, at most every 20 s. `?prepasstrial=0` off; a forced `?leafpre=` has none.
import type { LeafPrepass } from './nanite-lib/gpu/prepass.ts';
import type { AutoQuality } from './hud.ts';

const ENABLED = new URLSearchParams(location.search).get('prepasstrial') !== '0';
const BEFORE_MS = 1500, SETTLE_MS = 1000, AFTER_MS = 1500, EVERY_MS = 20000, KEEP = 0.93;

export function createPrepassTrial(auto: AutoQuality, prepass: LeafPrepass, zoomed: () => boolean, log: (text: string) => void) {
  const samples: [number, number][] = []; // (time, eased GPU ms)
  let trial: { at: number; before: number; was: boolean; density: number } | null = null;
  let next = performance.now() + 6000, lastDensity = 0;
  const mean = (from: number, to: number): number => {
    const v = samples.filter(([t]) => t >= from && t <= to).map(([, m]) => m);
    return v.length >= 5 ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  return {
    /** Per frame, after auto quality's step. */
    step(now: number): void {
      if (!ENABLED || !auto.on || auto.gpuMs <= 0) return;
      samples.push([now, auto.gpuMs]);
      while (samples.length && samples[0][0] < now - 5000) samples.shift();
      if (trial) {
        if (zoomed()) { prepass.mode = 'auto'; trial = null; return; } // (the view changed under it)
        if (now - trial.at < SETTLE_MS + AFTER_MS) return;
        const after = mean(trial.at + SETTLE_MS, now), d = trial.density;
        const better = after < trial.before * KEEP;
        if (better && !trial.was) prepass.onAt = Math.min(prepass.onAt, d * 0.9); // (on pays here: on from below this density)
        if (better && trial.was) prepass.onAt = Math.max(prepass.onAt, d * 1.15); // (off pays here)
        prepass.offAt = prepass.onAt * 0.89;
        prepass.mode = 'auto';
        log(`leaf prepass ${trial.was ? 'off' : 'on'} at density ${d.toFixed(2)}: ${trial.before.toFixed(1)} -> ${after.toFixed(1)} ms, ${better ? 'kept' : 'back'} (switches at ${prepass.onAt.toFixed(2)})`);
        trial = null;
        next = now + EVERY_MS;
        return;
      }
      const d = prepass.density;
      if (prepass.mode !== 'auto' || zoomed() || now < next || !(d > 0) || (lastDensity && Math.abs(d / lastDensity - 1) < 1 / 3)) return;
      const before = mean(now - BEFORE_MS, now);
      if (!(before > 0)) return;
      lastDensity = d;
      trial = { at: now, before, was: prepass.on, density: d };
      prepass.mode = !prepass.on;
    },
  };
}
