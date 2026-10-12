// The on-screen numbers: the performance panel (src/perf-panel.js; click copies a report) and the text HUD under it
// (scene counters, quality, toggles). The harness keeps the old first HUD line instead of the panel: it times
// frames itself and reads them from there in screenshots.
import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.ts';
import { PerfPanel, short } from './perf-panel.ts';
import type { FlyControls } from './controls.ts';
import type { NaniteForest } from './nanite/forest.ts';
import type { TAA } from './taa.ts';

/** The auto-quality controller's state (src/main.ts). */
export interface AutoQuality {
  on: boolean;
  budget: number; // GPU ms
  maxTau: number;
  scale: number; // resolution scale (of the base pixel ratio)
  gpuMs: number;
  renderMs?: number;
  computeMs?: number;
  frameMs?: number; // eased frame time
  busy: boolean;
  busySince?: number; // (when the pending timestamp readback started)
  onSample?: (renderMs: number, computeMs: number) => void; // each raw timestamp sample (src/profile.ts)
  trials?: string[]; // resolution steps tried and what they saved (src/auto-quality.ts; the harness's autoTest)
  forget?: () => void; // drops the controller's resolution trial state (the harness, between views)
}

export interface HudContext {
  renderer: THREE.WebGPURenderer;
  camera: THREE.PerspectiveCamera;
  controls: FlyControls;
  forest: NaniteForest;
  taa: TAA;
  auto: AutoQuality;
  size: THREE.Vector2; // the scene's pixels
  output: THREE.Vector2; // the canvas's (the TAA upscales to it)
  samples: number;
  adapterName: string;
  harness: boolean;
  shadowsOn(): boolean;
}

type ForestStats = Awaited<ReturnType<NaniteForest['readStats']>>;

export function createHud(ctx: HudContext) {
  const { camera, controls, forest, taa, auto, size, samples } = ctx;
  const el = document.getElementById('hud')!; // (index.html)
  let frames = 0, acc = 0, last = performance.now(), fps = 0, ms = 0, shadowTris = 0;
  let gs: ForestStats | null = null;
  let widest = 0;
  const millions = (n: number): string => `${+(n / 1e6).toFixed(2)}M`;
  const agl = () => camera.position.y - heightAt(camera.position.x, camera.position.z);

  const perf = ctx.harness ? null : new PerfPanel(() => ({
    gpu: { render: auto.renderMs ?? 0, compute: auto.computeMs ?? 0, total: auto.gpuMs, budget: auto.budget },
    quality: { tau: forest.u.tau.value, auto: auto.on, scale: auto.scale, limited: auto.on && forest.u.tau.value >= auto.maxTau && auto.scale <= 0.5, shadows: ctx.shadowsOn() },
    resolution: { width: size.x, height: size.y, outWidth: ctx.output.x, outHeight: ctx.output.y, msaa: samples, taa: taa.enabled },
    scene: gs && {
      trees: gs.instances + gs.impostors, total: forest.treeCount, bushes: forest.instanceCount - forest.treeCount - forest.statueCount, statues: forest.statueCount, impostors: gs.impostors,
      clusters: gs.barkClusters + gs.leafClusters, swClusters: gs.swClusters ?? 0,
      tris: gs.barkTris + gs.leafTris, swTris: gs.swTris ?? 0, impostorTris: gs.impostors * 2, shadowTris,
    },
    camera: {
      x: camera.position.x, z: camera.position.z, agl: agl(), zoom: controls.zoom,
      yaw: THREE.MathUtils.radToDeg(controls.yaw), pitch: THREE.MathUtils.radToDeg(controls.pitch),
    },
    adapter: ctx.adapterName,
  }));

  async function update(): Promise<void> {
    gs = await forest.readStats();
    // (the shadow map's casters: on a phone they cost more than the view itself)
    const sh = ctx.shadowsOn() && forest.shadowActive ? await forest.readStats(forest.shadow) : null;
    shadowTris = sh ? sh.barkTris + sh.leafTris + sh.impostors * 2 : 0;
    const tris = gs.barkTris + gs.leafTris;
    const rows = [
      ...(perf ? [] : [['fps', `${fps.toFixed(0)}   ${ms.toFixed(2)} ms   gpu ${auto.gpuMs.toFixed(2)} ms`]]),
      // (short lines: the panel is as wide as the longest; the user: "wasting space")
      ['plants', `${(gs.instances + gs.impostors).toLocaleString()} shown · ${gs.impostors.toLocaleString()} impostors`],
      ['forest', `${millions(forest.treeCount)} trees + ${millions(forest.instanceCount - forest.treeCount - forest.statueCount)} bushes + ${forest.statueCount} statues`],
      ['altitude', `${Math.round(agl())} m · ${Math.round(controls.velocity.length())} m/s`],
      ['clusters', `${(gs.barkClusters + gs.leafClusters + (gs.swClusters ?? 0)).toLocaleString()} (${gs.barkClusters.toLocaleString()} bark · ${(gs.swClusters ?? 0).toLocaleString()} software)`],
      // (every triangle drawn: the clusters' in hardware and software, and the impostors' quads, 2 each)
      ['triangles', `${short(tris + (gs.swTris ?? 0) + gs.impostors * 2)} = ${short(tris)} hw + ${short(gs.swTris ?? 0)} sw + ${short(gs.impostors * 2)} impostors`],
      ['error', `${forest.u.tau.value.toFixed(2)} px ${auto.on ? `auto · ${auto.budget} ms` : 'manual'}${forest.frozen ? ' · FROZEN' : ''}`],
      ['debug', `${['off', 'clusters', 'DAG level', 'trees', 'tree types', 'rasterizer'][forest.u.debug.value]} · shadows ${ctx.shadowsOn() ? 'on' : 'off'} · taa ${taa.enabled ? 'on' : 'off'}`],
    ];
    // (labels in the accent colour, numbers bright: the performance panel's style)
    el.innerHTML = rows.map(([k, v]) => `<i>${k.toUpperCase()}</i>${v.replace(/\d[\d,]*(?:\.\d+)?/g, '<b>$&</b>')}`).join('\n');
    // it only ever grows (numbers changing width moved its left edge: layout shift)
    widest = Math.max(widest, el.offsetWidth);
    el.style.minWidth = `${widest}px`;
  }

  return {
    update,
    /** Per displayed frame. */
    frame(now: number, dt: number): void {
      perf?.frame(now);
      frames++;
      acc += dt;
      if (now - last > 500) {
        fps = frames / acc;
        ms = (acc / frames) * 1000;
        frames = 0;
        acc = 0;
        last = now;
        update();
      }
    },
    /** The harness's benchmark result, shown in the screenshots' HUD line. */
    setBenchMs(m: number): void {
      ms = m;
      fps = 1000 / m;
    },
    perf,
  };
}
