// Auto quality: steers the error threshold tau so the GPU frame time stays within the budget (a preset or manual [ ]
// turns it off).
// Changes are slow and have a dead band: every change of tau re-cuts the LOD of every tree on screen, so a controller
// that twitches every frame makes the whole forest shimmer. Past the coarsest tau it lowers the resolution instead
// (down to half the pixel ratio, in slower steps: each one restarts the TAA history); much of the cost doesn't depend
// on detail (fill, the culling of 2.5M instances), and phones hit that.
// The 5x zoom is another scene for the GPU (the far forest at full detail). tau moves with the zoom as it eases, in and
// out (`zoomTau`), and nothing changes after: the LOD goes by tau / zoom, so up to tau x zoom a statue's cut is the one it
// had unzoomed, and past that it only gets finer, up to tau `auto.maxTau`. Stepping to the budget a second after the zoom
// took the wings off the small statues (Lucy forest `oblique` at 1440p, tau 4.7 to 8: 10 -> 21% of a 17-32 px statue's
// shape, `--lodcheck`; the user: "we should be making them finer, not coarser"), and lowering the resolution, which the
// LOD and the impostors' sizes go by, was worse ("it changes statues noticeably"). Holding the unzoomed tau instead
// overflowed the cluster list from tau ~4 down (`--probe=caps`), dropping runs of neighbours as the view panned (the
// user: "groups of adjacent statues" flicker; `--dolly --step=0 --turn=0.02`: 64k events at tau 1, 240 at 4.7 or 8) at
// 25-30 ms. Only frames over 1.5 x ZOOM_FLOOR coarsen it once zoomed.
import * as THREE from 'three/webgpu';
import type { AutoQuality } from './hud.ts';
import { gpuBackend } from './three-gaps.ts';

/** While zoomed, `step`'s `over` is the frame time over this (ms): past 1.5 it coarsens, past ZOOM_RES the resolution drops. */
const ZOOM_FLOOR = 50;
const ZOOM_RES = 2.5;
/** The low-end tiers (see `tier`): how many, the least time on one before the next (ms), how far under the budget to come back. */
const MAX_TIER = 3, TIER_MS = 2500, TIER_BACK = 0.6;
/** A resolution step's trial: how long it's measured before and after (ms), and the share of its share of the pixels it must save. */
const SETTLE = 2000, PAYS = 5;
/**
 * `?autosim=x,noise,pixels,output` (--probe=autosim), a weak GPU's controller on the dev GPU: its GPU samples x x, plus `pixels` ms at full
 * resolution (by the square of the scale; the dev GPU's cost hardly follows the pixels where the laptop's does), plus `output` ms per
 * million canvas pixels (the TAA and the output pass), +- noise re-rolled every half second (a real GPU's drift: per sample, the
 * medians cancel it).
 */
const SIM = new URLSearchParams(location.search).get('autosim')?.split(',').map(Number);
let simAt = 0, simRoll = 1;

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
  setTier: (tier: number) => void = () => {},
): { step: (dt: number) => void; followZoom: () => void } {
  let lastAdjust = 0;
  // the unzoomed (tau, scale) while zoomed
  let saved: [number, number] | null = null;
  let zoomState = false, wasOn = auto.on, lastZoom = zoom?.zoom ?? 1, written = tau.value;
  const minTau = (): number => auto.minTau ?? 1;
  const zoomTau = (t: number, z: number): number => Math.min(t * z, Math.max(t, auto.maxTau));
  // Past the coarsest tau, the low-end tiers, what's least seen first. Tier 1 comes before the resolution (it's hardly seen, the blur
  // is), the others after it: with the lowest resolution, or one that doesn't pay. (The laptop's report: a third cut-off and short
  // windows read a step as not paying, and it sat at 75% with tier 3's flat shadows, at 48 fps where 64% had 55: --probe=autosim.)
  // 1: tiny impostors as fewer, bigger quads (narrowest 4 px: 45% fewer on `laptop`, the same image and flicker), a third of the
  // grass, wider, and the output within 2x the scene's pixel ratio (following the resolution down: an AMD iGPU upscaled 4x on DPR 3). 2: narrowest 6 px, less grass again, and the output at one pixel per CSS pixel (the TAA and the output pass). 3: the map's shadows for the average shadow. On a $700 laptop's Intel Xe2 at
  // the limit: 27 ms in the forest, 14 in the Lucy forest, on a 60 Hz screen. The last in is the first out, once well under;
  // if that goes over again soon, it stays for a minute (each change is seen).
  let tier = 0, tierAt = 0, tierHold = 0, lastDown = -1e9;
  /** What it did and when (the report's `auto steps`, the trials too): a device's path can't be guessed from where it ended. */
  const logStep = (text: string): void => {
    (auto.trials ??= []).push(`${(performance.now() / 1000).toFixed(0)}s ${text}`);
    if (auto.trials.length > 16) auto.trials.shift();
  };
  const setTierTo = (t: number): void => {
    logStep(`tier ${tier}->${t} at ${auto.gpuMs.toFixed(1)} ms, resolution ${auto.scale.toFixed(2)}`);
    tier = t;
    tierAt = performance.now();
    auto.tier = t;
    setTier(t);
  };
  let gen = 0; // (bumped while the view changes under it: a timestamp readback still in flight was the old view's)
  // A resolution step down is a trial: if it saved under a fifth of its share of the pixels, the cost isn't the
  // pixels (a phone 8 km up: 317k impostors and their shadows, half the pixels saved 9%), so it goes back and the
  // resolution holds (see `futile`): it only blurred the image ("makes it look lame", the user).
  // (compared by the median of the raw samples since the last change: the eased time lags every tau step)
  let trial: { from: number; before: number; at: number } | null = null;
  let futile: { gpu: number; at: number } | null = null;
  let scaleHold = 0, lastUp = -1e9, underAt = 0;
  /** The resolution it last had to leave, and until when it stays below it: a noisy GPU's good seconds climbed back to it, 50% to 96% and down every 20 s. */
  let ceiling = Infinity, ceilingUntil = 0;
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
    if (over <= 1.1) underAt = now; // (a tier for what lasts: each is seen, and a second's swing isn't worth one)
    // far from the budget (after a jump in cost: the zoom, a turn): bigger, quicker steps; x1.3 a half second was
    // seconds of slow frames, and /1.1 seconds of lost detail after
    const far = over > 1.5 || over < 0.5;
    // (slower while the resolution is lowered: each change restarts the TAA history; quicker on the way back up)
    if (now - lastAdjust < (far ? 250 : auto.scale !== 1 ? (over < 0.85 ? 700 : 1500) : 500)) return;
    // (zoomed, only past the floor, and never back up: it stays at the setting it was zoomed in with)
    const limit = zoomState ? 1.5 : 1.1;
    if (zoomState && over <= limit) return;
    // over the budget, the resolution above the base goes first (it's the extra: full detail came before it)
    if (over > limit && auto.scale > 1) setScale(Math.max(1, auto.scale * (far ? 0.75 : 0.85)));
    else if (over > limit && tau.value < auto.maxTau) tau.value = Math.min(auto.maxTau, tau.value * Math.min(far ? 1.6 : 1.3, over));
    else if (!zoomState && over > limit && tier < MAX_TIER && tau.value >= auto.maxTau && (tier === 0 || auto.scale <= 0.505 || futile)) {
      if (now - tierAt < TIER_MS || now - underAt < TIER_MS) return;
      if (now - lastDown < 3000) tierHold = now + 60000;
      setTierTo(tier + 1);
      if (timed) restart();
      return;
    }
    else if (over > (zoomState ? ZOOM_RES : limit) && auto.scale > 0.505 && !futile) {
      // (settled: a tier eases in over 1.5 s, and a short window of a noisy GPU's samples decides nothing)
      if (timed && !zoomState && now - lastAdjust < SETTLE) return;
      const before = median(Math.max(lastAdjust + 200, now - SETTLE), now);
      if (timed && !(before > 0)) return; // (not measured since the last change yet)
      const to = Math.max(0.5, auto.scale * (zoomState ? (far ? 0.75 : 0.85) : Math.SQRT1_2));
      // (a small last step saves too little to read: no trial. It's on the way to the lowest anyway)
      if (timed && !zoomState && 1 - (to / auto.scale) ** 2 > 0.4) trial = { from: auto.scale, before, at: now };
      // (back up too soon after coming down, it hunts, and each step is seen: the longer if it came straight back)
      if (!zoomState) {
        scaleHold = now + (now - lastUp < 10000 ? 60000 : 10000);
        ceiling = auto.scale;
        ceilingUntil = now + 60000;
      }
      // (half the pixels at once, outside the zoom: what's over a noisy GPU's swings. In steps of 28% the laptop's trials could
      // read under the cut-off when half the pixels saved it 5 of 21 ms; the way back up is in small steps)
      setScale(to);
      if (timed) restart(); // (measure the new resolution afresh)
    }
    // back up: the resolution first (it's what reads as sharp), under 85% of the budget (a step adds less than its
    // x1.38 pixels: the culling and the shadow map don't grow), then the detail, once the resolution is back.
    // "Under 60%" left it stuck blurry at ground level after the orbit (the user): 60-110% at half resolution.
    else if (zoomState) return;
    // (tier 1 goes last, with the resolution back: it came first)
    else if (tier > 1 || (tier === 1 && auto.scale >= 1)) {
      // (well under: the tier's saving comes back on top, and the steps above don't undo each other)
      if (over < TIER_BACK && now - tierAt > TIER_MS * 2 && now > tierHold) {
        lastDown = now;
        setTierTo(tier - 1);
        if (timed) restart();
      }
      return;
    }
    else if (auto.scale < 1 && over < 0.85 && now > scaleHold) {
      if (over > 0.5 && now < ceilingUntil && auto.scale / 0.85 >= ceiling) return; // (far under: the cost has changed)
      lastUp = now;
      setScale(Math.min(1, auto.scale / 0.85));
    }
    else if (tier > 0) return;
    // (not before the resolution is back: it ate the room)
    else if (over < 0.75 && tau.value > minTau() && auto.scale >= 1) tau.value = Math.max(minTau(), tau.value / (far ? 1.25 : 1.1));
    // at full detail with room to spare, past the base towards the screen's own pixels (a dense screen at 1.5 of
    // its 3 read blurry, the scene's pixels upscaled 2x): a step is x1.32 the pixels (and finer LOD), so under 55%
    // it lands under the budget's 1.1 and doesn't swing back
    else if (over < 0.55 && tau.value <= minTau() && auto.scale >= 1 && auto.scale < maxScale()) setScale(Math.min(maxScale(), auto.scale * 1.15));
    else return;
    lastAdjust = now;
  };

  /** Starts the measurement over: the view just changed under it. */
  const restart = (): void => {
    auto.gpuMs = 0;
    gen++;
    lastAdjust = performance.now();
  };

  /**
   * tau follows the zoom as it eases; zooming out restores the unzoomed setting. Called with the zoom, before the culling:
   * run after the frame, every frame was culled at the new zoom with the last frame's tau. The first frames of the ease move
   * the zoom by half each, and the Lucy forest's triangles go by about 1 / tau^2.5: 337k clusters mid-way against 70k at
   * either end (the user: "spikes to 20+ mil triangles").
   */
  const followZoom = (): void => {
    if (auto.on && !wasOn) saved = null; // (a preset was on in between: start over)
    wasOn = auto.on;
    if (!zoom) return;
    // (the frames while it eases in or out are neither view's: zooming out at the zoomed tau they're slow, and they
    // stepped the unzoomed tau up)
    if (Math.abs(zoom.zoom - zoom.zoomTarget) > 0.05 * zoom.zoomTarget) restart();
    const z = zoom.zoomTarget > 1;
    if (z !== zoomState) {
      zoomState = z;
      trial = futile = null;
      if (z && !saved) {
        saved = [tau.value, auto.scale]; // (kept if it's zoomed again on the way out)
        written = tau.value;
      }
      else if (saved && auto.on && saved[1] !== auto.scale) setScale(saved[1]);
      restart();
    }
    // (a preset's or a manual tau too: at tau 1-3 the zoom filled the cluster list. One set by hand while zoomed stays:
    // nothing follows the zoom any more, nothing is restored)
    if (saved && !auto.on && tau.value !== written) saved = null;
    if (saved && zoom.zoom !== lastZoom) written = tau.value = zoomTau(saved[0], zoom.zoom);
    lastZoom = zoom.zoom;
    if (!z && zoom.zoom === 1) saved = null;
  };

  const perFrame = (dt: number): void => {
    // (a preset or a manual tau: they're auto quality's to give up; Profile GPU only holds it still, and measures what's on)
    if (!auto.on && !auto.holding && tier > 0) setTierTo(0);
    if (auto.on && !saved && tau.value < minTau()) tau.value = minTau(); // (switched on from a finer preset)
    // frame time, always: under 20 fps it lowers the quality whatever the GPU timings say (a Mac's readback stalled
    // after two steps and left it at 6 fps with tau 1.69); without timestamp queries it's the only signal (vs 60 fps)
    auto.frameMs = auto.frameMs ? auto.frameMs * 0.95 + dt * 50 : dt * 1000;
    const timed = gpuBackend(renderer).trackTimestamp, now = performance.now();
    if (auto.on && (!timed || auto.frameMs > 50)) step(auto.frameMs / (zoomState ? ZOOM_FLOOR : timed ? 50 : 16.7), false);
    if (!timed) return;
    if (auto.busy && now - (auto.busySince ?? 0) < 1000) return; // (a readback that never settles is dropped)
    auto.busy = true;
    auto.busySince = now;
    const g0 = gen;
    Promise.all([renderer.resolveTimestampsAsync('render'), renderer.resolveTimestampsAsync('compute')]).then(([r, c]) => {
      auto.busy = false;
      if (r === undefined || !(r >= 0) || g0 !== gen) return;
      if (SIM && performance.now() - simAt > 500) {
        simAt = performance.now();
        simRoll = 1 + (SIM[1] ?? 0) * (Math.random() * 2 - 1);
      }
      const g = SIM ? ((r + (c || 0)) * SIM[0] + (SIM[2] ?? 0) * auto.scale ** 2 + ((SIM[3] ?? 0) * renderer.domElement.width * renderer.domElement.height) / 1e6) * simRoll : r + (c || 0), ease = (a: number | undefined, b: number): number => (a ? a * 0.9 + b * 0.1 : b);
      auto.gpuMs = ease(auto.gpuMs, g);
      auto.renderMs = ease(auto.renderMs, r);
      auto.computeMs = ease(auto.computeMs, c || 0);
      auto.onSample?.(r, c || 0);
      const t = performance.now();
      recent.push([t, g]);
      while (recent.length && recent[0][0] < t - 3000) recent.shift();
      if (trial && t - trial.at > SETTLE) {
        const after = median(trial.at + 300, t);
        if (!(after > 0) && t - trial.at < SETTLE * 2) return; // (a few more samples)
        const pixels = 1 - (auto.scale / trial.from) ** 2, saved = 1 - after / trial.before;
        logStep(`${trial.from.toFixed(2)}->${auto.scale.toFixed(2)} ${trial.before.toFixed(2)}->${after.toFixed(2)} ms: saved ${(saved * 100).toFixed(0)}% of ${(pixels * 100).toFixed(0)}% pixels`);
        if (saved < pixels / PAYS && auto.on) {
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
      // (the median of the last second: a single low sample after a change took a tier back, eased from nothing)
      if (auto.on && !zoomState && m > 0) step(m / auto.budget, true);
    }, (err) => {
      auto.busy = false;
      console.warn('GPU timestamp readback failed', err);
    });
  };
  return { step: perFrame, followZoom };
}
