// window.__demo in the WebGL mode (src/webgl/start.ts): the part of the harness API (src/harness-api.ts) that the
// views, benchmarks and screenshots need. The frame times are wall clock, each frame waited for (gl.finish); the GPU
// time is the timer queries' (EXT_disjoint_timer_query_webgl2, headless Chromium has it), 0 without them.
import * as THREE from 'three/webgpu';
import type { FlyControls } from '../controls.ts';
import { viewPose, type DemoState, type HarnessView } from '../harness-api.ts';
import type { AutoQuality } from '../hud.ts';
import type { TreeInstances } from '../placement.ts';
import type { createWebGLForest } from './forest.ts';

interface WebGLHarnessContext {
  timed: boolean; // (GPU timer queries)
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: FlyControls;
  frame(dt: number): void;
  forest: ReturnType<typeof createWebGLForest>;
  instances: TreeInstances;
  size: THREE.Vector2;
  tris(): number;
  updateHud(): void;
  heightOf(i: number): number;
  taa?: unknown; // (the output's TAA and god rays: --probe=cost switches them)
  rays?: unknown; // (instance i's height, m: the `lone` views) // (the scene details in screenshots: as this frame)
}

export function installWebGLHarness(demo: DemoState, ctx: WebGLHarnessContext): void {
  const { renderer, camera, controls, frame, forest, instances, size } = ctx;
  const gl = (renderer.backend as unknown as { gl: WebGL2RenderingContext }).gl;
  const finish = (): void => gl.finish();
  Object.assign(demo, {
    renderer, scene: ctx.scene, camera, controls, instances, webgl: true, taa: ctx.taa, rays: ctx.rays, glNear: forest.near,
    info: () => ({ backend: 'WebGL 2', output: `${size.x}x${size.y}`, trees: instances.a.length / 4, ...forest.stats() }),
    setView(v: HarnessView) {
      const all = instances.a.length / 4;
      const { x, y, z, yaw, pitch } = viewPose(v, instances, { all, trees: instances.trees, plants: all - instances.statues }, (i) => ctx.heightOf(i));
      camera.position.set(x, y, z);
      controls.yaw = yaw;
      controls.pitch = pitch;
      controls.velocity.set(0, 0, 0);
      controls.zoomTarget = controls.zoom = v.zoom ?? 1;
    },
    async renderFrame() {
      frame(1 / 60);
      finish();
    },
    async renderOnce() {
      frame(1 / 60);
      ctx.updateHud();
      frame(1 / 60);
      finish();
    },
    async bench(n = 120) {
      for (let i = 0; i < 5; i++) (frame(1 / 60), finish());
      const gpu: number[] = [];
      for (let i = 0; ctx.timed && i < n; i++) {
        frame(1 / 60);
        gpu.push((await renderer.resolveTimestampsAsync('render')) ?? 0);
      }
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        frame(1 / 60);
        finish();
        ms.push(performance.now() - t);
      }
      const median = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
      const med = median(ms);
      return { frameMs: med, medianMs: med, gpuRenderMs: median(gpu), gpuComputeMs: 0, cpuMs: med, clusters: 0, tris: ctx.tris(), ...forest.stats() };
    },
  });
}

/**
 * The page's own loop for `ms` (auto quality `on`): every resolution step (auto.trials: when, from, to, the eased
 * frame time), the frames over 50 ms (when, how long) and the frames whose canvas was resized after they were drawn
 * (shown blank: a flicker): what a person sees in the first seconds.
 */
export async function runLoop(renderer: THREE.WebGPURenderer, auto: AutoQuality, loop: () => void, ms: number, on: boolean, drawnWidth: () => number) {
  auto.on = on;
  auto.trials = [];
  const long: string[] = [], t0 = performance.now();
  let last = t0, frames = 0, resizedAfterDraw = 0; // (a canvas resized after its frame is shown blank: a flicker)
  await new Promise<void>((done) => renderer.setAnimationLoop(() => {
    const t = performance.now();
    loop();
    if (renderer.domElement.width !== drawnWidth()) resizedAfterDraw++;
    const now = performance.now();
    if (now - last > 50) long.push(`${((now - t0) / 1000).toFixed(2)} s: ${Math.round(now - last)} ms (${Math.round(now - t)} in the loop)`);
    last = now;
    frames++;
    if (now - t0 >= ms) (renderer.setAnimationLoop(null), done());
  }));
  return { frames, fps: +((frames * 1000) / (performance.now() - t0)).toFixed(1), scale: auto.scale, steps: auto.trials, resizedAfterDraw, long };
}
