// Auto quality: steers the error threshold tau so the GPU frame time stays within the budget (a preset or manual [ ]
// turns it off).
// Changes are slow and have a dead band: every change of tau re-cuts the LOD of every tree on screen, so a controller
// that twitches every frame makes the whole forest shimmer. Past the coarsest tau it lowers the resolution instead
// (down to half the pixel ratio, in slower steps: each one restarts the TAA history); much of the cost doesn't depend
// on detail (fill, the culling of 2.5M instances), and phones hit that.
// The 5x zoom is another scene for the GPU (the far forest at full detail), so zooming in starts from the unzoomed
// setting (sharp: jumping to the last zoom's setting, learned at a costly spot, was the user's "washed" zoom) and
// zooming out restores it at once: with one setting it stayed at the zoom's tau 8 for seconds after.
import * as THREE from 'three/webgpu';
import type { AutoQuality } from './hud.ts';
import { gpuBackend } from './three-gaps.ts';

/**
 * The per-frame step of the controller. `tau`: the forest's error threshold; `setScale`: the resolution scale (of the
 * base pixel ratio); `zoom`: the controls' zoom and its target (the swap happens as the button changes; null: one
 * setting for both, ?autozoom=0).
 */
export function createAutoQuality(
  renderer: THREE.WebGPURenderer,
  auto: AutoQuality,
  tau: { value: number },
  setScale: (s: number) => void,
  zoom: { zoom: number; zoomTarget: number } | null,
): (dt: number) => void {
  let lastAdjust = 0;
  // the unzoomed (tau, scale) while zoomed
  let saved: [number, number] | null = null;
  let zoomState = false, wasOn = auto.on;
  let gen = 0; // (bumped while the view changes under it: a timestamp readback still in flight was the old view's)
  // A resolution step down is a trial: if it saved under a third of its share of the pixels, the cost isn't the
  // pixels (a phone 8 km up: 317k impostors and their shadows, half the pixels saved 9%), so it goes back and the
  // resolution holds (see `futile`): it only blurred the image ("makes it look lame", the user).
  // (compared by the median of the raw samples since the last change: the eased time lags every tau step)
  let trial: { from: number; before: number; at: number } | null = null;
  let futile: { gpu: number; at: number } | null = null;
  const recent: [number, number][] = []; // (time, GPU ms) of each raw sample, the last 3 s
  const median = (from: number, to: number): number => {
    const v = recent.filter(([t]) => t > from && t <= to).map(([, m]) => m).sort((a, b) => a - b);
    return v.length >= 3 ? v[v.length >> 1] : NaN;
  };
  auto.forget = (): void => {
    trial = futile = null;
    recent.length = 0;
  };

  const step = (over: number, timed: boolean): void => {
    const now = performance.now();
    // far from the budget (after a jump in cost: the zoom, a turn): bigger, quicker steps; x1.3 a half second was
    // seconds of slow frames, and /1.1 seconds of lost detail after
    const far = over > 1.5 || over < 0.5;
    // (slower while the resolution is lowered: each change restarts the TAA history; quicker on the way back up)
    if (now - lastAdjust < (far ? 250 : auto.scale < 1 ? (over < 0.85 ? 700 : 1500) : 500)) return;
    if (over > 1.1 && tau.value < auto.maxTau) tau.value = Math.min(auto.maxTau, tau.value * Math.min(far ? 1.6 : 1.3, over));
    else if (over > 1.1 && auto.scale > 0.5 && !futile) {
      const before = median(lastAdjust + 200, now);
      if (timed && !(before > 0)) return; // (not measured since the last change yet)
      if (timed) trial = { from: auto.scale, before, at: now };
      setScale(Math.max(0.5, auto.scale * (far ? 0.75 : 0.85)));
      if (timed) restart(); // (measure the new resolution afresh)
    }
    // back up: the resolution first (it's what reads as sharp), under 85% of the budget (a step adds less than its
    // x1.38 pixels: the culling and the shadow map don't grow), then the detail, once the resolution is back.
    // "Under 60%" left it stuck blurry at ground level after the orbit (the user): 60-110% at half resolution.
    else if (auto.scale < 1 && over < 0.85) setScale(Math.min(1, auto.scale / 0.85));
    else if (over < 0.75 && tau.value > 1 && auto.scale >= 1) tau.value = Math.max(1, tau.value / (far ? 1.25 : 1.1)); // (not before the resolution is back: it ate the room)
    else return;
    lastAdjust = now;
  };

  /** Starts the measurement over: the view just changed under it. */
  const restart = (): void => {
    auto.gpuMs = 0;
    gen++;
    lastAdjust = performance.now();
  };

  /** Zooming out restores the unzoomed setting; holds still while the zoom eases. */
  const followZoom = (): void => {
    if (auto.on && !wasOn) saved = null; // (a preset was on in between: start over)
    wasOn = auto.on;
    if (!zoom) return;
    // (the frames while it eases in or out are neither view's: zooming out at the zoomed tau they're slow, and they
    // stepped the unzoomed tau up)
    if (Math.abs(zoom.zoom - zoom.zoomTarget) > 0.05 * zoom.zoomTarget) restart();
    const z = zoom.zoomTarget > 1;
    if (z === zoomState) return;
    zoomState = z;
    trial = futile = null;
    if (z) saved = [tau.value, auto.scale];
    else if (saved && auto.on) {
      tau.value = saved[0];
      if (saved[1] !== auto.scale) setScale(saved[1]);
    }
    restart();
  };

  return (dt: number): void => {
    followZoom();
    // frame time, always: under 20 fps it lowers the quality whatever the GPU timings say (a Mac's readback stalled
    // after two steps and left it at 6 fps with tau 1.69); without timestamp queries it's the only signal (vs 60 fps)
    auto.frameMs = auto.frameMs ? auto.frameMs * 0.95 + dt * 50 : dt * 1000;
    const timed = gpuBackend(renderer).trackTimestamp, now = performance.now();
    if (auto.on && (!timed || auto.frameMs > 50)) step(auto.frameMs / (timed ? 50 : 16.7), false);
    if (!timed) return;
    if (auto.busy && now - (auto.busySince ?? 0) < 1000) return; // (a readback that never settles is dropped)
    auto.busy = true;
    auto.busySince = now;
    const g0 = gen;
    Promise.all([renderer.resolveTimestampsAsync('render'), renderer.resolveTimestampsAsync('compute')]).then(([r, c]) => {
      auto.busy = false;
      if (r === undefined || !(r >= 0) || g0 !== gen) return;
      const g = r + (c || 0), ease = (a: number | undefined, b: number): number => (a ? a * 0.9 + b * 0.1 : b);
      auto.gpuMs = ease(auto.gpuMs, g);
      auto.renderMs = ease(auto.renderMs, r);
      auto.computeMs = ease(auto.computeMs, c || 0);
      auto.onSample?.(r, c || 0);
      const t = performance.now();
      recent.push([t, g]);
      while (recent.length && recent[0][0] < t - 3000) recent.shift();
      if (trial && t - trial.at > 900) {
        const after = median(trial.at + 300, t);
        if (!(after > 0) && t - trial.at < 2000) return; // (a few more samples)
        const pixels = 1 - (auto.scale / trial.from) ** 2, saved = 1 - after / trial.before;
        (auto.trials ??= []).push(`${trial.from.toFixed(2)}->${auto.scale.toFixed(2)} ${trial.before.toFixed(2)}->${after.toFixed(2)} ms: saved ${(saved * 100).toFixed(0)}% of ${(pixels * 100).toFixed(0)}% pixels`);
        if (saved < pixels / 3 && auto.on) {
          setScale(trial.from);
          futile = { gpu: trial.before, at: t };
          restart();
        }
        trial = null;
        return;
      }
      if (trial) return; // (no other step while one is on trial)
      const m = median(Math.max(lastAdjust + 200, t - 1000), t);
      // (held until the cost changes by half, not before 10 s, or for a minute: each retry is a second of blur, and
      // GPU timings drift by 30% on their own)
      if (futile && ((m > 0 && Math.abs(m / futile.gpu - 1) > 0.5 && t - futile.at > 10000) || t - futile.at > 60000)) futile = null;
      if (auto.on) step(auto.gpuMs / auto.budget, true);
    }, (err) => {
      auto.busy = false;
      console.warn('GPU timestamp readback failed', err);
    });
  };
}
