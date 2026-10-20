// Shader compilation at startup. three.js compiles a pipeline the first time it draws or dispatches with it: the GPU
// process compiles those one after another, ~8 s of a desktop's 18 s load (a phone's ~11 s of 43). Here the render
// pipelines are compiled ahead with renderer.compileAsync, one call per mesh so they compile side by side, each
// started as soon as its material is final (the forest's while the ground and the impostors are still being made),
// and the compute passes the same way (compileComputeAsync, collected by a dry run of the frame's culling).
// `?precompile=0` for the old way: everything compiled as it's first drawn (warmUp alone).
import * as THREE from 'three/webgpu';
import { PHASE2_LAYER } from './nanite-lib/index.ts';
import { gpuBackend } from './three-gaps.ts';
import type { LoadingScreen } from './loading.ts';

/**
 * Compiles in flight read the renderer's render target and MRT as they build their shaders (the output's type and
 * attachments), so from `hold()` until warmUp the renderer stays on the scene's target: anything else that renders
 * meanwhile does it through `apart()` (synchronously: no compile resumes in between).
 */
export class Precompile {
  readonly jobs: Promise<unknown>[] = [];
  /** Each compile's name, start and end (ms since the navigation started): the loading log names the slowest. */
  readonly times: { name: string; start: number; end: number }[] = [];
  private held = false;
  private readonly computes = new Set<THREE.ComputeNode>();

  constructor(
    readonly renderer: THREE.WebGPURenderer,
    readonly scene: THREE.Scene,
    readonly camera: THREE.Camera,
    readonly target: THREE.RenderTarget,
    readonly mrt: THREE.MRTNode,
    readonly on = true,
  ) {}

  /** Puts the renderer on the scene's target (and MRT), where the compiles find it. */
  hold(): void {
    if (!this.on) return;
    this.renderer.setRenderTarget(this.target);
    this.renderer.setMRT(this.mrt);
    this.held = true;
  }

  /** Starts compiling every visible mesh under `objects` for the main view (both phases' layers), each on its own. */
  add(...objects: THREE.Object3D[]): void {
    if (!this.on) return;
    if (!this.held) this.hold();
    const layers = this.camera.layers.mask;
    this.camera.layers.set(0);
    this.camera.layers.enable(PHASE2_LAYER);
    for (const o of objects)
      o.traverseVisible((m) => {
        if ((m as THREE.Mesh).isMesh) this.track(m.name || m.type, this.renderer.compileAsync(m, this.camera, this.scene));
      });
    this.camera.layers.mask = layers;
  }

  /** Runs `fn` (synchronous GPU work into other targets: the impostor bake, the sky capture) off the scene's target. */
  apart<T>(fn: () => T): T {
    if (!this.held) return fn();
    const r = this.renderer;
    r.setRenderTarget(null);
    r.setMRT(null);
    try {
      return fn();
    } finally {
      r.setRenderTarget(this.target);
      r.setMRT(this.mrt);
    }
  }

  /**
   * Starts compiling the compute passes that `run` dispatches (it's run with dispatching switched off) that weren't
   * already; returns how many.
   */
  addComputes(run: () => void): number {
    if (!this.on) return 0;
    const r = this.renderer, nodes = new Set<THREE.ComputeNode>();
    const dispatch = r.compute;
    r.compute = ((n: THREE.ComputeNode | THREE.ComputeNode[]) => void [n].flat().forEach((x) => nodes.add(x))) as typeof r.compute;
    try {
      run();
    } finally {
      r.compute = dispatch;
    }
    const fresh = [...nodes].filter((n) => !this.computes.has(n));
    for (const n of fresh) {
      this.computes.add(n);
      this.track(`compute ${n.name || n.id}`, r.compileComputeAsync(n));
    }
    return fresh.length;
  }

  private track(name: string, job: Promise<unknown>): void {
    const t = { name, start: performance.now(), end: 0 };
    this.times.push(t);
    this.jobs.push(job.then(() => (t.end = performance.now())));
  }

  /** A compile started by `after` is in flight: draw frames through `apart`. */
  pending = false;

  /**
   * Compiles `objects` after the load, while frames are drawn (through `apart` while `pending`); resolves when
   * they're compiled. (A compile reads the renderer's target as it goes, between frames.)
   */
  async after(...objects: THREE.Object3D[]): Promise<void> {
    if (!this.on) return;
    const from = this.jobs.length;
    this.pending = true;
    this.hold();
    this.add(...objects);
    try {
      await Promise.all(this.jobs.slice(from));
    } finally {
      this.pending = false;
      this.held = false;
      this.renderer.setRenderTarget(null);
      this.renderer.setMRT(null);
    }
  }

  /** Waits for everything started so far; returns the slowest few and the last to finish, for the log. */
  async done(): Promise<string> {
    await Promise.all(this.jobs);
    const slow = [...this.times].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 3);
    const last = this.times.reduce((a, b) => (b.end > a.end ? b : a), this.times[0]);
    const at = (t: { start: number; end: number }) => `${Math.round(t.end - t.start)} ms from ${(t.start / 1000).toFixed(1)} s`;
    return `${slow.map((t) => `${t.name} ${at(t)}`).join(', ')}; last done: ${last ? `${last.name} ${at(last)}` : 'none'}`;
  }
}

export interface WarmScene {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  target: THREE.RenderTarget;
  mrt: THREE.MRTNode;
  sun: THREE.DirectionalLight;
  shadowsOn: boolean;
  /** Groups drawn one at a time (the rest of `all` hidden), named for the status line. */
  groups: [string, THREE.Object3D[]][];
  all: THREE.Object3D[];
  /** The frame's GPU stages one at a time, the last a whole frame. */
  stages: [string, () => void][];
}

/**
 * Draws each group once and runs each stage once, so whatever wasn't compiled ahead (the shadow-map versions of the
 * casters, the full-screen passes, or everything with ?precompile=0) compiles behind the loading screen; between
 * them the status line and the bar move.
 */
export async function warmUp(ui: LoadingScreen, w: WarmScene): Promise<void> {
  const { renderer, scene, camera, sun } = w;
  const all = w.all;
  const wasVisible = all.map((o) => o.visible);
  renderer.setRenderTarget(w.target);
  renderer.setMRT(w.mrt);
  camera.layers.set(0);
  camera.layers.enable(PHASE2_LAYER);
  for (let k = 0; k < w.groups.length; k++) {
    const [label, objects] = w.groups[k];
    await ui.update(0.86 + (0.07 * k) / w.groups.length, `Compiling shaders: ${label}`, false);
    const t = performance.now();
    all.forEach((o, i) => (o.visible = wasVisible[i] && objects.includes(o)));
    sun.shadow.needsUpdate = w.shadowsOn; // (the shadow-map versions of the casters too)
    renderer.render(scene, camera);
    ui.note(`Compiled ${label} (${Math.round(performance.now() - t)} ms)`);
  }
  all.forEach((o, i) => (o.visible = wasVisible[i]));
  camera.layers.set(0);
  renderer.setMRT(null);
  renderer.setRenderTarget(null);
  for (let k = 0; k < w.stages.length; k++) {
    const [label, run] = w.stages[k];
    await ui.update(0.93 + (0.06 * k) / w.stages.length, `Compiling shaders: ${label}`, false);
    const t = performance.now();
    run();
    await gpuBackend(renderer).device.queue.onSubmittedWorkDone();
    ui.note(`Compiled ${label} (${Math.round(performance.now() - t)} ms)`);
  }
}
