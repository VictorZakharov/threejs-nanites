// The WebGL mode's on-screen numbers (src/webgl/start.ts): the same performance panel as WebGPU's (src/perf-panel.ts:
// FPS, 1% low, frame time, GPU time where the browser has WebGL's timer queries (not Firefox: GPU shows --); a click
// copies the report), and the scene details under it (src/hud.ts's layout).
import * as THREE from 'three/webgpu';
import { heightAt } from '../terrain.ts';
import { PerfPanel, short } from '../perf-panel.ts';
import type { FlyControls } from '../controls.ts';
import type { AutoQuality } from '../hud.ts';
import type { createWebGLForest } from './forest.ts';

interface WebGLHudContext {
  tris(): number; // (the last frame's triangles, the shadow map's included)
  statues(): number; // (0 till the model has arrived)
  camera: THREE.PerspectiveCamera;
  controls: FlyControls;
  forest: ReturnType<typeof createWebGLForest>;
  auto: AutoQuality;
  tau: { value: number };
  size: THREE.Vector2; // (the drawing buffer's)
  adapterName: string;
  harness: boolean;
  shadowsOn(): boolean;
}

export function createWebGLHud(ctx: WebGLHudContext) {
  const { camera, controls, forest, auto, tau, size } = ctx;
  const el = document.getElementById('hud')!; // (index.html)
  let frames = 0, acc = 0, last = performance.now(), fps = 0, ms = 0, tris = 0, widest = 0;
  const agl = () => camera.position.y - heightAt(camera.position.x, camera.position.z);
  const millions = (n: number): string => `${+(n / 1e6).toFixed(2)}M`;

  const perf = ctx.harness ? null : new PerfPanel(() => {
    const s = forest.stats();
    tris = ctx.tris();
    return {
      gpu: { render: auto.gpuMs, compute: 0, total: auto.gpuMs, budget: auto.budget }, // (0 without timers: shown as --)
      quality: { tau: tau.value, auto: auto.on, scale: auto.scale, limited: auto.on && auto.scale <= 0.5, shadows: ctx.shadowsOn() },
      resolution: { width: size.x, height: size.y, outWidth: size.x, outHeight: size.y, msaa: 4, taa: false },
      scene: {
        trees: s.instances + s.impostors, total: forest.treeCount, bushes: forest.bushCount, statues: ctx.statues(), impostors: s.impostors,
        clusters: 0, swClusters: 0, tris: tris - s.impostors * 2, swTris: 0, impostorTris: s.impostors * 2, shadowTris: 0, // (tris: the shadow map's included)
      },
      camera: {
        x: camera.position.x, z: camera.position.z, agl: agl(), zoom: controls.zoom,
        yaw: THREE.MathUtils.radToDeg(controls.yaw), pitch: THREE.MathUtils.radToDeg(controls.pitch),
      },
      adapter: `${ctx.adapterName} (WebGL mode)`,
    };
  });

  function update(): void {
    const s = forest.stats();
    tris = ctx.tris();
    const rows = [
      ...(perf ? [] : [['fps', `${fps.toFixed(0)}   ${ms.toFixed(2)} ms   gpu ${auto.gpuMs.toFixed(2)} ms`]]),
      ['mode', 'WebGL 2 (reduced: no WebGPU)'],
      ['plants', `${(s.instances + s.impostors).toLocaleString()} shown · ${s.impostors.toLocaleString()} impostors`],
      ['forest', `${millions(forest.treeCount)} trees + ${millions(forest.bushCount)} bushes${ctx.statues() ? ` + ${ctx.statues()} statues` : ''}`],
      ['altitude', `${Math.round(agl())} m · ${Math.round(controls.velocity.length())} m/s`],
      ['triangles', `${short(tris)} (shadows included)`],
      ['detail', `${tau.value.toFixed(2)} ${auto.on ? `auto · ${auto.budget} ms frame` : 'manual'} · ${Math.round(auto.scale * 100)}% resolution`],
      ['shadows', ctx.shadowsOn() ? 'on' : 'off'],
    ];
    el.innerHTML = rows.map(([k, v]) => `<i>${k.toUpperCase()}</i>${v.replace(/\d[\d,]*(?:\.\d+)?/g, '<b>$&</b>')}`).join('\n');
    widest = Math.max(widest, el.offsetWidth); // (it only ever grows: see src/hud.ts)
    el.style.minWidth = `${widest}px`;
  }

  return {
    perf,
    update,
    /** Per displayed frame. */
    frame(now: number, dt: number): void {
      perf?.frame(now);
      frames++;
      acc += dt;
      if (now - last > 500) {
        fps = frames / acc;
        ms = (acc / frames) * 1000;
        frames = acc = 0;
        last = now;
        update();
      }
    },
  };
}
