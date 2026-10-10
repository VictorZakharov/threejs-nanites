// window.__demo: what the headless harness (tools/harness.mjs) drives the demo with: views, frames, timings.
import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.ts';

/**
 * ctx: { renderer, scene, camera, forest, controls, adapter, instances, buildMs, size, auto, frame(dt), loop(),
 * setShadows(on), shadowsOn(), updateHud(), setBenchMs(ms) }
 */
export function installHarnessApi(demo, ctx) {
  const { renderer, scene, camera, forest, controls, adapter, instances, buildMs, size, auto, frame, loop, setShadows, updateHud } = ctx;
Object.assign(demo, {
  renderer, scene, camera, forest, controls,
  info: () => ({
    adapter: `${adapter.info?.vendor} ${adapter.info?.architecture} ${adapter.info?.description ?? ''}`.trim(),
    size: `${size.x}x${size.y}`,
    trees: forest.instanceCount,
    forestRadius: Math.round(instances.radius),
    dagBuildMs: Math.round(buildMs),
    ...forest.stats,
  }),
  setView(v) {
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
      const dist = v.trunk ?? v.nearTree;
      x = tx + Math.sin(yaw) * dist;
      z = tz + Math.cos(yaw) * dist;
      if (v.trunk) y = ty + (v.agl ?? 1.5);
      else {
        y = Math.max(heightAt(x, z) + 1.7, ty + (v.agl ?? 3));
        pitch = Math.atan2(ty + 6 - y, v.nearTree);
      }
    }
    camera.position.set(x, y, z);
    controls.yaw = yaw;
    controls.pitch = pitch;
    controls.velocity.set(0, 0, 0);
    // right-mouse zoom factor (1 = none), applied at once instead of easing in
    controls.zoomTarget = controls.zoom = v.zoom ?? 1;
  },
  async renderOnce(benchResult) {
    if (benchResult) ctx.setBenchMs(benchResult.medianMs);
    frame(1 / 60);
    await updateHud();
    frame(1 / 60);
    await renderer.backend.device.queue.onSubmittedWorkDone();
  },
  stats: () => forest.readStats(),
  /** Harness sweeps: move one thing that normally follows the camera, keep the view fixed. */
  setShift(what, x, z) {
    forest.main.lodShift.set(0, 0, 0);
    forest.shadow.lodShift.set(0, 0, 0);
    demo.shadowShift.set(0, 0, 0);
    const t = { lod: forest.main.lodShift, shadowlod: forest.shadow.lodShift, shadow: demo.shadowShift }[what];
    t?.set(x, 0, z);
  },
  /** Times a shadow toggle off and on (each followed by a rendered frame). */
  async shadowToggleMs() {
    const out = [];
    for (const on of [false, true]) {
      const t = performance.now();
      setShadows(on);
      frame(1 / 60);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      out.push(Math.round(performance.now() - t));
    }
    return out;
  },
  /** Runs the real loop (auto quality on, flying forward) for `ms`, reports where the controller settled. */
  async autoTest(ms = 5000, budget = auto.budget, speed = 10) {
    auto.on = true;
    auto.budget = budget;
    auto.gpuMs = 0;
    forest.u.tau.value = 1;
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
    return { tau: +forest.u.tau.value.toFixed(2), scale: +auto.scale.toFixed(2), size: `${size.x}x${size.y}`, gpuMs: +auto.gpuMs.toFixed(2), fps: +((n * 1000) / (performance.now() - t0)).toFixed(1), budget };
  },
  async bench(n = 120) {
    const device = renderer.backend.device;
    const ts = renderer.backend.trackTimestamp;
    for (let i = 0; i < 5; i++) {
      frame(1 / 60); // warm up (pipelines compile on first use)
      await device.queue.onSubmittedWorkDone();
      if (ts) { await renderer.resolveTimestampsAsync('render'); await renderer.resolveTimestampsAsync('compute'); }
    }
    // 1) GPU time per frame from timestamp queries (render passes incl. shadows, and the culling compute)
    const gpuR = [], gpuC = [], cpu = [];
    for (let i = 0; ts && i < n; i++) {
      const t = performance.now();
      frame(1 / 60);
      cpu.push(performance.now() - t);
      gpuR.push(await renderer.resolveTimestampsAsync('render'));
      gpuC.push(await renderer.resolveTimestampsAsync('compute'));
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
    const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
    const s = await forest.readStats();
    const sh = await forest.readStats(forest.shadow);
    return {
      shadowTris: ctx.shadowsOn() ? sh.barkTris + sh.leafTris : 0,
      frameMs,
      gpuRenderMs: med(gpuR),
      gpuComputeMs: med(gpuC),
      cpuMs: med(cpu),
      medianMs: frameMs,
      clusters: s.barkClusters + s.leafClusters,
      tris: s.barkTris + s.leafTris,
      instances: s.instances,
      ...s,
    };
  },
});

}
