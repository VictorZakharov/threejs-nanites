// window.__demo in the WebGL mode (src/webgl/start.ts): the part of the harness API (src/harness-api.ts) that the
// views, benchmarks and screenshots need. No GPU timers on WebGL here: the frame times are wall clock, each frame
// waited for (gl.finish).
import * as THREE from 'three/webgpu';
import { heightAt } from '../terrain.ts';
import type { FlyControls } from '../controls.ts';
import type { DemoState, HarnessView } from '../harness-api.ts';
import type { TreeInstances } from '../placement.ts';
import type { createWebGLForest } from './forest.ts';

interface WebGLHarnessContext {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: FlyControls;
  frame(dt: number): void;
  forest: ReturnType<typeof createWebGLForest>;
  instances: TreeInstances;
  size: THREE.Vector2;
}

export function installWebGLHarness(demo: DemoState, ctx: WebGLHarnessContext): void {
  const { renderer, camera, controls, frame, forest, instances, size } = ctx;
  const gl = (renderer.backend as unknown as { gl: WebGL2RenderingContext }).gl;
  const finish = (): void => gl.finish();
  Object.assign(demo, {
    renderer, scene: ctx.scene, camera, controls, instances, webgl: true,
    info: () => ({ backend: 'WebGL 2', output: `${size.x}x${size.y}`, trees: instances.a.length / 4, ...forest.stats() }),
    setView(v: HarnessView) {
      const y = v.y ?? heightAt(v.x, v.z) + (v.agl ?? 2);
      camera.position.set(v.x, y, v.z);
      controls.yaw = THREE.MathUtils.degToRad(v.yaw ?? 0);
      controls.pitch = THREE.MathUtils.degToRad(v.pitch ?? 0);
      controls.velocity.set(0, 0, 0);
      controls.zoomTarget = controls.zoom = v.zoom ?? 1;
    },
    async renderFrame() {
      frame(1 / 60);
      finish();
    },
    async renderOnce() {
      frame(1 / 60);
      frame(1 / 60);
      finish();
    },
    async bench(n = 120) {
      for (let i = 0; i < 5; i++) (frame(1 / 60), finish());
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        frame(1 / 60);
        finish();
        ms.push(performance.now() - t);
      }
      const med = [...ms].sort((a, b) => a - b)[ms.length >> 1];
      renderer.info.reset();
      frame(1 / 60); // (one frame's triangles, the shadow map's included)
      const info = renderer.info.render;
      return { frameMs: med, medianMs: med, gpuRenderMs: 0, gpuComputeMs: 0, cpuMs: med, clusters: 0, tris: info.triangles, ...forest.stats() };
    },
  });
}
