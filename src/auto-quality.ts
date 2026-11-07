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
/** Frames this much slower than the display, the main thread idle: the GPU is behind (`?behind=`, see behindMs). */
const BEHIND = Number(new URLSearchParams(location.search).get('behind') ?? 1.2);
/** The zoom's coarsest tau on the low-end tiers (`?zoomlowtau=`; see zoomTau). */
const ZOOM_LOW_TAU = Number(new URLSearchParams(location.search).get('zoomlowtau') ?? 16);
/** The low-end tiers (see `tier`): how many, the least time on one before the next (ms), how far under the budget to come back. */
const MAX_TIER = 3, TIER_MS = 2500, TIER_BACK = 0.6;
/** A tier stepped down to within BOUNCE_MS of coming back up from it is held for BOUNCE_HOLD (ms). */
const BOUNCE_MS = 30000, BOUNCE_HOLD = 120000;
/** The coarsest tau on the last tier at the lowest resolution (`?lowmaxtau=`). */
const LOW_MAX_TAU = Number(new URLSearchParams(location.search).get('lowmaxtau') ?? 16);
/** A resolution step's trial: how long it's measured before and after (ms), and the share of its share of the pixels it must save. */
const SETTLE = 2000, PAYS = 5;
/** Far over the budget (x2): the wait between steps (ms). */
const HURRY_MS = 700;
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
/**
 * The low-end tier the last visit on this screen settled at (any scene; 0 when none was kept), for what's built once at load
 * (the grass's density). Not under the harness unless `?autoremember=1`.
 */
export function rememberedTier(params: URLSearchParams, harness: boolean): number {
  if (params.has('remembertier')) return Number(params.get('remembertier')); // (a test: as if the last visit settled there)
  if (params.get('autoremember') === '0' || (harness && params.get('autoremember') !== '1')) return 0;
  const screenKey = ` ${screen.width}x${screen.height}@${devicePixelRatio} `;
  let tier = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('nanite-auto ') && k.includes(screenKey)) tier = Math.max(tier, (JSON.parse(localStorage.getItem(k) ?? '{}') as { tier?: number }).tier ?? 0);
    }
  } catch {
    // (storage blocked: 0)
  }
  return tier;
}

export function createAutoQuality(
  renderer: THREE.WebGPURenderer,
  auto: AutoQuality,
  tau: { value: number },
  setScale: (s: number) => void,
  maxScale: () => number,
  zoom: { zoom: number; zoomTarget: number } | null,
  setTier: (tier: number) => void = () => {},
): { step: (dt: number) => void; followZoom: () => void; log: (text: string) => void } {
  let lastAdjust = 0;
  // the unzoomed (tau, scale) while zoomed
  let saved: [number, number] | null = null;
  let zoomState = false, wasOn = auto.on, lastZoom = zoom?.zoom ?? 1, written = tau.value;
  const minTau = (): number => auto.minTau ?? 1;
  // (on the low-end tiers the zoom may coarsen to ZOOM_LOW_TAU: the AMD PC's Lucy forest zoomed at tau 8 was 14.9 ms, over its
  // budget, and the user saw it lag as they panned; at 16 11.5 ms, the small statues' faces gone but their shapes kept; 24 broke
  // them up. A fast GPU never gets to the tiers, so its zoom is as before)
  const zoomTau = (t: number, z: number): number => Math.min(t * z, Math.max(t, tier >= 1 ? Math.max(auto.maxTau, ZOOM_LOW_TAU) : auto.maxTau));
  // Past the coarsest tau, the low-end tiers, what's least seen first. Tier 1 comes before the resolution (it's hardly seen, the blur
  // is), the others after it: with the lowest resolution, or one that doesn't pay. (The laptop's report: a third cut-off and short
  // windows read a step as not paying, and it sat at 75% with tier 3's flat shadows, at 48 fps where 64% had 55: --probe=autosim.)
  // 1: tiny impostors as fewer, bigger quads (narrowest 4 px: 45% fewer on `laptop`, the same image and flicker), a third of the
  // grass, wider, the floor's relief in 8 steps, and the output within 2x the scene's pixel ratio (following the resolution down: an AMD iGPU upscaled 4x on DPR 3). 2: narrowest 6 px, less grass again, the shadow map half its side, and the output at one pixel per CSS pixel (the TAA and the output pass). 3: the map's shadows for the average shadow. On a $700 laptop's Intel Xe2 at
  // the limit: 27 ms in the forest, 14 in the Lucy forest, on a 60 Hz screen. The last in is the first out, once well under;
  // if that goes over again soon, it stays for a minute (each change is seen).
  let tier = 0, tierAt = 0, tierHold = 0, lastDown = -1e9, lowTauAt = -1e9;
  /** What it did and when (the report's `auto steps`, the trials too): a device's path can't be guessed from where it ended. */
  const logStep = (text: string): void => {
    (auto.trials ??= []).push(`${(performance.now() / 1000).toFixed(0)}s ${text}`);
    if (auto.trials.length > 16) auto.trials.shift();
  };
  // (what a tier saved from submit to done, ms, learned on the way up: the timers miss the output's compositing, a cost of its
  // own rather than a share (as a ratio, 1.43 from 18.8 -> 13.1 ms, a cheap spot at tier 2 came back to 1 within 5 s). In Chrome on the
  // AMD PC tier 2 -> 1 at 7.4 ms of timers took the frames from 12.6 ms submit to done to 27, every half a minute)
  const tierSaves: number[] = [];
  let lastQ = 0, savesAt = 0, leftTier: { tier: number; q: number; t: number } | null = null;
  const setTierTo = (t: number): void => {
    // (two steps within the settling time, as when hurrying 1 -> 2 -> 3: the first tier is the one learned, by the whole saving,
    // so it can't come back on what the second saved)
    if (t > tier && lastQ > 0) leftTier = { tier: leftTier?.tier ?? tier, q: leftTier?.q ?? lastQ, t: performance.now() };
    logStep(`tier ${tier}->${t} at ${auto.gpuMs.toFixed(1)} ms, resolution ${auto.scale.toFixed(2)}`);
    tier = t;
    if (t < MAX_TIER && tau.value > auto.maxTau && !zoomState) tau.value = auto.maxTau; // (past maxTau only on the last tier)
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
    // (twice the budget or more: no trials and short waits. The AMD PC took 16 s at 15-17 fps to reach tier 3 from the start)
    const hurry = over > 2 && !zoomState;
    // (slower while the resolution is lowered: each change restarts the TAA history; quicker on the way back up)
    if (now - lastAdjust < (far ? 250 : auto.scale !== 1 ? (over < 0.85 ? 700 : 1500) : 500)) return;
    // (zoomed, only past the floor, and never back up: it stays at the setting it was zoomed in with)
    const limit = zoomState ? 1.5 : 1.1;
    if (zoomState && over <= limit) return;
    // over the budget, the resolution above the base goes first (it's the extra: full detail came before it)
    if (over > limit && auto.scale > 1) setScale(Math.max(1, auto.scale * (far ? 0.75 : 0.85)));
    else if (over > limit && tau.value < auto.maxTau) tau.value = Math.min(auto.maxTau, tau.value * Math.min(far ? 1.6 : 1.3, over));
    else if (!zoomState && over > limit && tier < MAX_TIER && tau.value >= auto.maxTau && (tier === 0 || auto.scale <= 0.505 || futile)) {
      const wait = hurry ? HURRY_MS : TIER_MS;
      if (now - tierAt < wait || now - underAt < wait) return;
      // (back down soon after coming back up: held there. Within 3 s it was a minute; the AMD PC flying between the statues and
      // above them came back 5-10 s into a cheap stretch and fell behind again at the next costly one, a few seconds of lag
      // each time, three times in 4 minutes)
      if (now - lastDown < BOUNCE_MS) tierHold = now + BOUNCE_HOLD;
      setTierTo(tier + 1);
      if (timed) restart();
      return;
    }
    else if (over > (zoomState ? ZOOM_RES : limit) && auto.scale > 0.505 && !futile) {
      // (settled: a tier eases in over 1.5 s, and a short window of a noisy GPU's samples decides nothing)
      if (timed && !zoomState && now - lastAdjust < (hurry ? HURRY_MS : SETTLE)) return;
      const before = median(Math.max(lastAdjust + 200, now - SETTLE), now);
      if (timed && !(before > 0)) return; // (not measured since the last change yet)
      const to = Math.max(0.5, auto.scale * (zoomState ? (far ? 0.75 : 0.85) : Math.SQRT1_2));
      // (a small last step saves too little to read: no trial. It's on the way to the lowest anyway)
      if (timed && !hurry && 1 - (to / auto.scale) ** 2 > 0.4) trial = { from: auto.scale, before, at: now };
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
    // at the last tier and the lowest resolution, still over: coarser past maxTau, up to LOW_MAX_TAU (the AMD PC among the
    // Lucy forest's statues: tier 3, 50%, tau 8, 15-16 ms of timers, 33-37 ms from submit to done; their geometry is ~6 ms
    // of it, and at 16 a zoomed statue kept its shape). Back to maxTau when the tier is left (setTierTo)
    else if (!zoomState && over > limit && tier >= MAX_TIER && auto.scale <= 0.505 && tau.value < LOW_MAX_TAU) {
      if (timed && now - lastAdjust < (hurry ? HURRY_MS : SETTLE)) return;
      tau.value = Math.min(LOW_MAX_TAU, tau.value * Math.min(1.3, over));
      lowTauAt = now;
    }
    // (nothing comes back while the frames wait or fall behind, however low the timers: in Chrome on the AMD PC it went back up to
    // tier 1 at 5.9 ms of timers with 27 ms from submit to done)
    else if (upBlocked) return;
    // and back down from there first, before anything else comes back: slowly (the route between the statues and above them
    // swung the cost every few seconds, and a quick way back undid each climb before it reached them)
    else if (!zoomState && tau.value > auto.maxTau && over < 0.6 && now - lowTauAt > 10000) tau.value = Math.max(auto.maxTau, tau.value / 1.15);
    else if (!zoomState && tau.value > auto.maxTau) return; // (nothing else comes back meanwhile)
    // back up: the resolution first (it's what reads as sharp), under 85% of the budget (a step adds less than its
    // x1.38 pixels: the culling and the shadow map don't grow), then the detail, once the resolution is back.
    // "Under 60%" left it stuck blurry at ground level after the orbit (the user): 60-110% at half resolution.
    else if (zoomState) return;
    // (tier 1 goes last, with the resolution back: it came first)
    else if (tier > 1 || (tier === 1 && auto.scale >= 1)) {
      // (well under: the tier's saving comes back on top, and the steps above don't undo each other)
      const fits = !(lastQ + (tierSaves[tier - 1] ?? 0) > auto.budget * 0.9);
      if (over < TIER_BACK && fits && now - tierAt > TIER_MS * 2 && now > tierHold) {
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

  // Where it settled, kept per screen (`auto.remember`: the storage key; not under the harness): the next visit starts there, not
  // at full quality (the AMD PC's first 16 s at 15-17 fps). Written once it has held still 8 s; it moves on from there as usual.
  let restored = false, lastSave = 0;
  const remember = (now: number): void => {
    const key = auto.remember;
    if (!key) return;
    try {
      if (!restored) {
        restored = true;
        const s = JSON.parse(localStorage.getItem(key) ?? 'null') as { tier: number; scale: number; tau: number } | null;
        if (!s || !auto.on) return;
        tau.value = Math.max(tau.value, Math.min(s.tau, auto.maxTau));
        if (s.scale > 0 && s.scale < auto.scale) setScale(s.scale);
        if (s.tier > 0) setTierTo(Math.min(MAX_TIER, s.tier));
        logStep(`started where it settled: tier ${s.tier}, resolution ${s.scale.toFixed(2)}, tau ${s.tau.toFixed(1)}`);
        lastAdjust = now;
        return;
      }
      if (!auto.on || zoomState || now - lastSave < 5000 || now - lastAdjust < 8000 || now - tierAt < 8000) return;
      lastSave = now;
      localStorage.setItem(key, JSON.stringify({ tier, scale: auto.scale, tau: tau.value }));
    } catch {
      // (storage blocked: it starts at full quality, as before)
    }
  };

  // Frames behind the display with the main thread idle: the GPU is behind, whatever its timers say. The AMD PC after 2-3
  // minutes' flying: 42 fps, 40 ms from submit to done, while the timers read 14 ms (the browser's compositing of the canvas
  // and the iGPU's clocks aren't in them): auto quality had climbed back to 69% on the timers, and the frames queued (the
  // user: "enormous input lags and FPS drops"). Then the frame time stands in for the GPU's: budget x frame / display frame.
  // (only on a 60-80 Hz display or a low-end device: a fast GPU on a 144 Hz screen can be held back by the browser's own
  // presenting, which no quality step fixes)
  const slowGpu = (): boolean => auto.budget / 0.8 >= 12 || tier >= 1;
  const paces: [number, number][] = []; // (time, ms since the frame before) over the last second
  const behindMs = (now: number): number => {
    while (paces.length && paces[0][0] < now - 1000) paces.shift();
    if (paces.length < 20) return 0;
    const v = paces.map(([, d]) => d).sort((a, b) => a - b), paced = v[v.length >> 1], display = auto.budget / 0.8;
    if (!slowGpu()) return 0;
    return paced > display * BEHIND && (auto.mainMs ?? 0) < display * 0.5 ? (auto.budget * paced) / display : 0;
  };
  let behindLogged = 0, underRead = 1, underAt2 = 0, behindSince = 0;
  let queuedSince = 0, upBlocked = false;
  const BEHIND_LEARN = 3000, LEARN_AFTER = 20000, SUSTAIN = 1500;
  // (the under-read factor's excess halves in this long, ms)
  const UNDER_HALF = 180000;
  const perFrame = (dt: number): void => {
    remember(performance.now());
    paces.push([performance.now(), dt * 1000]);
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
      const behind = behindMs(t);
      // (how much the timers under-read when the frames fell behind, kept and eased back to 1 over minutes: going by the timers
      // alone between those times, it went straight back up and behind again, tier 3 -> 1 -> 3 and 50% -> 69% -> 50% every
      // half a minute on the AMD PC, with 30-40 ms from submit to done throughout)
      // (learned only from frames behind for BEHIND_LEARN ms on end, not before LEARN_AFTER ms from the start: in the user's
      // Chrome stalls of 30-80 ms with 6 ms of timers (the GPU idle) taught it 3x, and it sat at its floor, blurry, for nothing)
      // (m is NaN for a moment after each change, too few samples: that's not the frames catching up)
      behindSince = behind > 0 && !(behind <= m) ? behindSince || t : 0;
      if (behind > m && m > 0 && t - behindSince > BEHIND_LEARN && t > LEARN_AFTER) underRead = Math.min(2, Math.max(underRead, behind / m));
      else underRead = 1 + (underRead - 1) * 0.5 ** ((t - underAt2) / UNDER_HALF);
      underAt2 = t;
      auto.underRead = underRead;
      if (behind > m && t - behindLogged > 10000 && auto.on && !zoomState) {
        behindLogged = t;
        logStep(`frames behind the display: ${(behind / 0.8).toFixed(1)} ms paced, GPU timers ${m.toFixed(1)} ms: steering by the frames`);
      }
      auto.behindMs = behind;
      // (and from submit to done: what a frame really costs the GPU, the browser's compositing too, and past a frame's time
      // the frames waiting: at 60 fps with 10-11 ms of timers the AMD PC's frames waited 26-37 ms, two frames of input lag,
      // with the frame rate never falling behind)
      // (both only when it lasts SUSTAIN ms: a stall isn't the GPU's load, and a lower quality can't fix it)
      const q = slowGpu() ? auto.queueMs ?? 0 : 0;
      lastQ = q;
      if (leftTier && t - leftTier.t > 3000) {
        if (q > 0) tierSaves[leftTier.tier] = Math.max(0, leftTier.q - q);
        logStep(`tier ${leftTier.tier} -> ${tier}: ${leftTier.q.toFixed(1)} -> ${q.toFixed(1)} ms from submit to done`);
        leftTier = null;
      }
      for (let i = 0; i < tierSaves.length; i++) if (tierSaves[i]) tierSaves[i] *= 0.5 ** ((t - savesAt) / UNDER_HALF);
      savesAt = t;
      queuedSince = q > auto.budget ? queuedSince || t : 0;
      const queued = queuedSince && t - queuedSince > SUSTAIN ? q : 0;
      const behindNow = behindSince && t - behindSince > SUSTAIN ? behind : 0;
      upBlocked = q > auto.budget * 0.85 || behind > 0;
      auto.steer = [m, behindNow, queued];
      if (auto.on && !zoomState && m > 0) step(Math.max(m * underRead, behindNow, queued) / auto.budget, true);
    }, (err) => {
      auto.busy = false;
      console.warn('GPU timestamp readback failed', err);
    });
  };
  return { step: perFrame, followZoom, log: logStep };
}
