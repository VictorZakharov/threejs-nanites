// Auto quality: steers the error threshold tau so the GPU frame time stays within the budget (a preset or manual [ ]
// turns it off).
// Changes are slow and have a dead band: every change of tau re-cuts the LOD of every tree on screen, so a controller
// that twitches every frame makes the whole forest shimmer. Past the coarsest tau it lowers the resolution instead
// (down to half the pixel ratio, in slower steps: each one restarts the TAA history); much of the cost doesn't depend
// on detail (fill, the culling of 2.5M instances), and phones hit that.
// The 5x zoom is another scene for the GPU (the far forest at full detail), so zooming in starts from the unzoomed
// setting (sharp: jumping to the last zoom's setting, learned at a costly spot, was the user's "washed" zoom) and
// zooming out restores it at once: with one setting it stayed at the zoom's tau 8 for seconds after. From there it
// jumps (`jump`): its first measurement of the zoomed view sets tau by cost ~ tau^-k (k 1, then from the two points),
// twice, rather than a dozen x0.91 steps every half second, each a visible re-cut from near to far (the user: "zooming
// in still redraws visibly over 1-2 sec").
import * as THREE from 'three/webgpu';
import type { AutoQuality } from './hud.ts';
import { gpuBackend } from './three-gaps.ts';

/**
 * The per-frame step of the controller. `tau`: the forest's error threshold; `setScale`: the resolution scale (of the
 * base pixel ratio); `maxScale`: the highest scale (the scene at the output's resolution, above 1 on a screen denser
 * than the base ratio); `zoom`: the controls' zoom and its target (the swap happens as the button changes; null: one
 * setting for both, ?autozoom=0).
 */
export function createAutoQuality(
  renderer: THREE.WebGPURenderer,
  auto: AutoQuality,
  tau: { value: number },
  setScale: (s: number) => void,
  maxScale: () => number,
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
  // after zooming in: the jumps left, and the last one's (tau, cost over the budget) (?autojump=0: steps only)
  let jump: { left: number; t?: number; o?: number } | null = null;
  const jumps = new URLSearchParams(location.search).get('autojump') !== '0';
  const recent: [number, number][] = []; // (time, GPU ms) of each raw sample, the last 3 s
  const median = (from: number, to: number): number => {
    const v = recent.filter(([t]) => t > from && t <= to).map(([, m]) => m).sort((a, b) => a - b);
    return v.length >= 3 ? v[v.length >> 1] : NaN;
  };
  auto.forget = (): void => {
    trial = futile = jump = null;
    recent.length = 0;
  };

  const step = (over: number, timed: boolean): void => {
    const now = performance.now();
    // far from the budget (after a jump in cost: the zoom, a turn): bigger, quicker steps; x1.3 a half second was
    // seconds of slow frames, and /1.1 seconds of lost detail after
    const far = over > 1.5 || over < 0.5;
    // (slower while the resolution is lowered: each change restarts the TAA history; quicker on the way back up)
    if (now - lastAdjust < (far ? 250 : auto.scale !== 1 ? (over < 0.85 ? 700 : 1500) : 500)) return;
    // over the budget, the resolution above the base goes first (it's the extra: full detail came before it)
    if (over > 1.1 && auto.scale > 1) setScale(Math.max(1, auto.scale * (far ? 0.75 : 0.85)));
    else if (over > 1.1 && tau.value < auto.maxTau) tau.value = Math.min(auto.maxTau, tau.value * Math.min(far ? 1.6 : 1.3, over));
    // (zoomed, only far over: the jump set it; a step and a trial undone after were two redraws 1-3 s after the
    // zoom, the user's "zooming in parallel to the ground, the redraw after 1-2 sec")
    else if (over > (zoomState ? 1.5 : 1.1) && auto.scale > 0.5 && !futile) {
      const before = median(lastAdjust + 200, now);
      if (timed && !(before > 0)) return; // (not measured since the last change yet)
      if (timed && !zoomState) trial = { from: auto.scale, before, at: now };
      setScale(Math.max(0.5, auto.scale * (far ? 0.75 : 0.85)));
      if (timed) restart(); // (measure the new resolution afresh)
    }
    // back up: the resolution first (it's what reads as sharp), under 85% of the budget (a step adds less than its
    // x1.38 pixels: the culling and the shadow map don't grow), then the detail, once the resolution is back.
    // "Under 60%" left it stuck blurry at ground level after the orbit (the user): 60-110% at half resolution.
    else if (auto.scale < 1 && over < (zoomState ? 0.5 : 0.85)) setScale(Math.min(1, auto.scale / 0.85));
    // (not before the resolution is back: it ate the room; zoomed, only far under the budget: the jumps set it, and
    // x0.91 every second or so after was a re-cut of the statues each time, the user's redraw after the zoom)
    else if (over < (zoomState ? 0.5 : 0.75) && tau.value > 1 && auto.scale >= 1) tau.value = Math.max(1, tau.value / (far ? 1.25 : 1.1));
    // at full detail with room to spare, past the base towards the screen's own pixels (a dense screen at 1.5 of
    // its 3 read blurry, the scene's pixels upscaled 2x): a step is x1.32 the pixels (and finer LOD), so under 55%
    // it lands under the budget's 1.1 and doesn't swing back
    else if (over < 0.55 && tau.value <= 1 && auto.scale >= 1 && auto.scale < maxScale()) setScale(Math.min(maxScale(), auto.scale * 1.15));
    else return;
    lastAdjust = now;
  };

  /**
   * One jump of tau towards 0.9 of the budget, from the median cost since the last change; false once it's done (in
   * the dead band, at a bound, the resolution off its base) and the steps take over.
   */
  const leap = (t: number): boolean => {
    // (soon: the frame after a change is already cut by the new tau, and a jump while the zoom still eases in is
    // hidden in its motion; at 300 ms the second came ~0.85 s after the click, a redraw of its own: the user)
    const m = t - lastAdjust > 120 ? median(lastAdjust + 50, t) : NaN;
    if (!(m > 0)) return true; // (not measured yet)
    const o = m / auto.budget, j = jump!;
    const done = (): false => ((jump = null), false);
    if ((o > 0.75 && o < 1.1) || auto.scale !== 1) return done();
    // (the secant in log-log: a tau step that changed nothing, or the wrong way, is noise: k 1)
    const k = j.t && j.o && j.t !== tau.value ? Math.log(j.o / o) / Math.log(tau.value / j.t) : 1;
    const kk = Math.min(2, Math.max(0.5, k || 1)), want = tau.value * (o / 0.9) ** (1 / kk);
    const next = Math.min(auto.maxTau, Math.max(1, want));
    // past the coarsest tau, the rest from the resolution in the same jump (by its pixels: x0.75 steps after were
    // a redraw each, and a trial undone)
    const rest = want > auto.maxTau ? (o * (tau.value / auto.maxTau) ** kk) / 0.9 : 1;
    if (rest > 1.1 / 0.9) setScale(Math.max(0.5, Math.sqrt(1 / rest)));
    if (Math.abs(next / tau.value - 1) < 0.05) return rest > 1.1 / 0.9 ? (restart(), done()) : done();
    (j.t = tau.value), (j.o = o), (tau.value = next);
    if (--j.left <= 0) jump = null;
    restart();
    return true;
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
    trial = futile = jump = null;
    if (z) (saved = [tau.value, auto.scale]), jumps && (jump = { left: 2 });
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
      if (jump && auto.on && leap(t)) return;
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
