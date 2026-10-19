// window.__demo: what the headless harness (tools/harness.ts) drives the demo with: views, frames, timings.
import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.ts';
import { detailShift } from './planet.ts';
import type { FlyControls } from './controls.ts';
import type { AutoQuality } from './hud.ts';
import type { NaniteForest } from './nanite/forest.ts';
import type { TAA } from './taa.ts';
import type { TreeInstances } from './placement.ts';
import { gpuBackend } from './three-gaps.ts';
import type { CoverMap } from './placement.ts';
import type { createLitterMap } from './ground/litter-map.ts';
import type { createGrass } from './grass.ts';
import type { ImpostorAtlas } from './impostors.ts';
import type { createHud } from './hud.ts';
import type { Music } from './music.ts';

/** window.__demo before the API is installed (main.ts): readiness, the boot error, the shadow map's debug shift. */
export interface DemoState {
  ready: boolean;
  error: string | null;
  shadowShift: THREE.Vector3;
  [key: string]: unknown;
}

export interface HarnessContext {
  renderer: THREE.WebGPURenderer;
  sceneRT: THREE.RenderTarget; // (the scene before TAA: colour, and the trees' wind motion / debug 6 ids)
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  forest: NaniteForest;
  taa: TAA; // (the harness's type masks switch it off: blended edges read as other types' hues)
  controls: FlyControls;
  adapter: GPUAdapter;
  instances: TreeInstances;
  buildMs: number;
  size: THREE.Vector2;
  auto: AutoQuality;
  frame(dt: number): void;
  loop(): void;
  setShadows(on: boolean): void;
  setScale(s: number): void;
  shadowsOn(): boolean;
  updateHud(): Promise<void>;
  setBenchMs(ms: number): void;
}

/** A harness viewpoint (tools/harness/views.ts): world x/z, height above ground or absolute, degrees, zoom. */
export interface HarnessView {
  x: number;
  z: number;
  y?: number;
  agl?: number;
  yaw?: number;
  pitch?: number;
  nearTree?: number;
  trunk?: number;
  zoom?: number;
}

export function installHarnessApi(demo: DemoState, ctx: HarnessContext): void {
  Object.assign(demo, harnessApi(demo, ctx));
}

/** window.__demo once the demo is up, as the harness and its probes see it (tools/, typed by this). */
export type Demo = DemoState & ReturnType<typeof harnessApi> & DemoExtras;

/** What main.ts adds to window.__demo besides the API (for probes). */
export interface DemoExtras {
  coverMap: CoverMap; // (the canopy cover / fallen leaves map, --probe=autumn)
  leafOf: string[]; // (each variant's kind of leaf)
  litter: ReturnType<typeof createLitterMap>;
  grass: ReturnType<typeof createGrass>;
  atlas: ImpostorAtlas;
  hud: ReturnType<typeof createHud>;
  music: Music;
  perfReport(): string | undefined;
  loadLog: { t: number; msg: string }[]; // (the loading log's lines, ms since the navigation started: --load)
  profile(): Promise<string>;
}

function harnessApi(demo: DemoState, ctx: HarnessContext) {
  const { renderer, scene, camera, forest, controls, adapter, instances, buildMs, size, auto, frame, loop, setShadows, updateHud, sceneRT, taa } = ctx;
  return {
  renderer, scene, camera, forest, controls, instances, sceneRT, taa,
  info: () => ({
    adapter: `${adapter.info?.vendor} ${adapter.info?.architecture} ${adapter.info?.description ?? ''}`.trim(),
    size: `${size.x}x${size.y}`, // (the scene's; the canvas's below)
    output: `${renderer.getDrawingBufferSize(new THREE.Vector2()).toArray().join('x')}`,
    trees: forest.instanceCount,
    forestRadius: Math.round(instances.radius),
    dagBuildMs: Math.round(buildMs),
    ...forest.stats,
  }),
  setView(v: HarnessView) {
    let x = v.x, z = v.z, yaw = THREE.MathUtils.degToRad(v.yaw ?? 0), pitch = THREE.MathUtils.degToRad(v.pitch ?? 0);
    let y = v.y ?? heightAt(x, z) + (v.agl ?? 2);
    if (v.nearTree || v.trunk) {
      // the closest tree to (x, z): `nearTree` frames it from that many metres away; `trunk` faces its trunk
      // from that many metres (from the trunk's axis), level, at `agl` above the tree's base
      let best = 0, bd = Infinity;
      for (let i = 0; i < forest.instanceCount; i++) {
        const d = Math.hypot(instances.a[i * 4] - x, instances.a[i * 4 + 2] - z);
        if (d < bd) { bd = d; best = i; }
      }
      const tx = instances.a[best * 4], tz = instances.a[best * 4 + 2], ty = instances.a[best * 4 + 1];
      const dist = v.trunk ?? v.nearTree ?? 0;
      x = tx + Math.sin(yaw) * dist;
      z = tz + Math.cos(yaw) * dist;
      if (v.trunk) y = ty + (v.agl ?? 1.5);
      else {
        y = Math.max(heightAt(x, z) + 1.7, ty + (v.agl ?? 3));
        pitch = Math.atan2(ty + 6 - y, dist);
      }
    }
    camera.position.set(x, y, z);
    controls.yaw = yaw;
    controls.pitch = pitch;
    controls.velocity.set(0, 0, 0);
    // right-mouse zoom factor (1 = none), applied at once instead of easing in
    controls.zoomTarget = controls.zoom = v.zoom ?? 1;
  },
  /** One frame, nothing else (renderOnce draws two, the HUD between): --typematch picks the frame it shoots. */
  async renderFrame() {
    frame(1 / 60);
    await gpuBackend(renderer).device.queue.onSubmittedWorkDone();
  },
  async renderOnce(benchResult?: { medianMs: number }) {
    if (benchResult) ctx.setBenchMs(benchResult.medianMs);
    frame(1 / 60);
    await updateHud();
    frame(1 / 60);
    await gpuBackend(renderer).device.queue.onSubmittedWorkDone();
  },
  stats: () => forest.readStats(),
  /** Harness sweeps: move one thing that normally follows the camera, keep the view fixed ('none': reset). */
  setShift(what: 'lod' | 'shadowlod' | 'shadow' | 'detail' | 'none', x: number, z: number) {
    detailShift.set(0, 0, 0);
    forest.main.lodShift.set(0, 0, 0);
    forest.shadow.lodShift.set(0, 0, 0);
    demo.shadowShift.set(0, 0, 0);
    if (what !== 'none') ({ lod: forest.main.lodShift, shadowlod: forest.shadow.lodShift, shadow: demo.shadowShift, detail: detailShift })[what].set(x, 0, z);
  },
  /** Times a shadow toggle off and on (each followed by a rendered frame). */
  async shadowToggleMs() {
    const out = [];
    for (const on of [false, true]) {
      const t = performance.now();
      setShadows(on);
      frame(1 / 60);
      await gpuBackend(renderer).device.queue.onSubmittedWorkDone();
      out.push(Math.round(performance.now() - t));
    }
    return out;
  },
  /** Runs the real frame loop (timestamps, auto quality) while `run` is pending (the profile probe). */
  async withLoop<T>(run: () => Promise<T>): Promise<T> {
    renderer.setAnimationLoop(loop);
    try {
      return await run();
    } finally {
      renderer.setAnimationLoop(null);
    }
  },
  /**
   * Auto quality across the zoom: the real loop at the current view, unzoomed / zoomed / unzoomed / zoomed for `ms`
   * each (the second zoom: does it come back to its own setting?). Per phase: tau and resolution scale each 250 ms,
   * until when the eased GPU time was over the budget by 10% (`ms`: to the end), and the frames over twice the budget.
   */
  async autoZoomTest(ms = 4000, budget = auto.budget) {
    auto.on = true;
    auto.budget = budget;
    auto.gpuMs = 0;
    auto.trials = [];
    const out = [];
    for (const z of [1, controls.zoomMax, 1, controls.zoomMax]) {
      controls.zoomTarget = z;
      const t0 = performance.now(), track: string[] = [];
      let overUntil = 0, slow = 0, n = 0, prev = t0, next = t0, longest = 0, scales = 0, lastScale = auto.scale;
      await new Promise<void>((done) => {
        renderer.setAnimationLoop(() => {
          loop();
          const now = performance.now();
          n++;
          if (now - prev > 2 * budget) slow++;
          longest = Math.max(longest, now - prev);
          if (auto.scale !== lastScale) (scales++, (lastScale = auto.scale));
          prev = now;
          if (auto.gpuMs > budget * 1.1) overUntil = Math.round(now - t0);
          if (now >= next) (track.push(`${forest.u.tau.value.toFixed(1)}/${auto.scale.toFixed(2)}`), (next += 250));
          if (now - t0 >= ms) (renderer.setAnimationLoop(null), done());
        });
      });
      out.push({ zoom: z, overUntilMs: overUntil, framesOver2x: slow, frames: n, longestMs: Math.round(longest), scaleChanges: scales, gpuMs: +auto.gpuMs.toFixed(2), tauScale: track.join(' ') });
    }
    controls.zoomTarget = controls.zoom = 1;
    return out;
  },
  /** Runs the real loop (auto quality on, flying forward) for `ms`, reports where the controller settled. */
  async autoTest(ms = 5000, budget = auto.budget, speed = 10) {
    auto.on = true;
    auto.budget = budget;
    auto.gpuMs = 0;
    auto.trials = [];
    auto.forget?.(); // (a new view: what the last one learned about the resolution doesn't hold)
    // (?autostart=low: from the lowest quality, as after the orbit: does it come back up?)
    const low = new URLSearchParams(location.search).get('autostart') === 'low';
    forest.u.tau.value = low ? auto.maxTau : 1;
    ctx.setScale(low ? 0.5 : 1);
    const fwd = () => controls.keys.add('KeyW');
    controls.speed = speed;
    fwd();
    const t0 = performance.now();
    let n = 0;
    renderer.setAnimationLoop(() => {
      loop();
      n++;
    });
    await new Promise((r) => setTimeout(r, ms));
    renderer.setAnimationLoop(null);
    controls.keys.clear();
    return { tau: +forest.u.tau.value.toFixed(2), scale: +auto.scale.toFixed(2), size: `${size.x}x${size.y}`, gpuMs: +auto.gpuMs.toFixed(2), fps: +((n * 1000) / (performance.now() - t0)).toFixed(1), budget, trials: auto.trials ?? [] };
  },
  async bench(n = 120) {
    const device = gpuBackend(renderer).device;
    const ts = gpuBackend(renderer).trackTimestamp;
    for (let i = 0; i < 5; i++) {
      frame(1 / 60); // warm up (pipelines compile on first use)
      await device.queue.onSubmittedWorkDone();
      if (ts) { await renderer.resolveTimestampsAsync('render'); await renderer.resolveTimestampsAsync('compute'); }
    }
    // 1) GPU time per frame from timestamp queries (render passes incl. shadows, and the culling compute)
    const gpuR: number[] = [], gpuC: number[] = [], cpu: number[] = [];
    for (let i = 0; ts && i < n; i++) {
      const t = performance.now();
      frame(1 / 60);
      cpu.push(performance.now() - t);
      gpuR.push((await renderer.resolveTimestampsAsync('render')) ?? 0);
      gpuC.push((await renderer.resolveTimestampsAsync('compute')) ?? 0);
    }
    // 2) throughput: frames pipelined like a real loop (max 2 in flight)
    const inflight = [];
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      if (inflight.length >= 2) await inflight.shift();
      frame(1 / 60);
      inflight.push(device.queue.onSubmittedWorkDone());
    }
    await Promise.all(inflight);
    const frameMs = (performance.now() - t0) / n;
    const med = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
    const s = await forest.readStats();
    const sh = await forest.readStats(forest.shadow);
    return {
      shadowTris: ctx.shadowsOn() && forest.shadowActive ? sh.barkTris + sh.leafTris : 0,
      frameMs,
      gpuRenderMs: med(gpuR),
      gpuComputeMs: med(gpuC),
      cpuMs: med(cpu),
      medianMs: frameMs,
      clusters: s.barkClusters + s.leafClusters,
      tris: s.barkTris + s.leafTris,
      ...s,
    };
  },
  };
}
