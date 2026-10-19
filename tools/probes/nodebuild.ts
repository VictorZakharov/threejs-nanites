// What each material's compile costs, split into the main thread's share (three.js's node builder, which competes
// with everything else on the main thread while loading) and the rest (the GPU process compiling the pipeline).
// Each visible mesh's material is cloned and compiled with compileAsync for the canvas's target (a new pipeline);
// `main` sums the main thread's busy stretches (a message ping loop's gaps over 4 ms) meanwhile, `ms` is the whole compile. Slowest first; ms at this page's
// pace (--cpu=N slows the main thread as on a phone).
import type { Demo } from '../../src/harness-api.ts';
import type * as THREE from 'three/webgpu';

async (demo: Demo) => {
  const { renderer, scene, camera } = demo;
  const meshes: THREE.Mesh[] = [];
  const layers = camera.layers.mask;
  camera.layers.enableAll();
  scene.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.Material & { isNodeMaterial?: boolean }).isNodeMaterial) meshes.push(m);
  });
  // (a ping loop through a MessageChannel: each gap over 4 ms is the main thread busy with something else)
  let busy = 0, last = 0, running = false;
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    if (!running) return;
    const now = performance.now();
    if (now - last > 4) busy += now - last;
    last = now;
    ch.port2.postMessage(0);
  };
  const out: { name: string; ms: number; main: number }[] = [];
  for (const m of meshes) {
    const c = m.clone();
    c.material = (m.material as THREE.Material).clone();
    await new Promise((r) => setTimeout(r, 50));
    busy = 0;
    running = true;
    last = performance.now();
    ch.port2.postMessage(0);
    const t = performance.now();
    await renderer.compileAsync(c, camera, scene);
    const ms = performance.now() - t;
    running = false;
    out.push({ name: m.name || m.type, ms: Math.round(ms), main: Math.round(busy) });
  }
  camera.layers.mask = layers;
  out.sort((a, b) => b.ms - a.ms);
  return { ms: out.reduce((s, r) => s + r.ms, 0), main: out.reduce((s, r) => s + r.main, 0), meshes: out };
}
