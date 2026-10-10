// The on-screen numbers: the performance panel (src/perf-panel.js; click copies a report) and the text HUD under it
// (scene counters, quality, toggles). The harness keeps the old first HUD line instead of the panel: it times
// frames itself and reads them from there in screenshots.
import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.ts';
import { PerfPanel } from './perf-panel.ts';

/** ctx: { renderer, camera, controls, forest, taa, auto, size, samples, adapterName, harness, shadowsOn() } */
export function createHud(ctx) {
  const { renderer, camera, controls, forest, taa, auto, size, samples } = ctx;
  const el = document.getElementById('hud');
  let frames = 0, acc = 0, last = performance.now(), fps = 0, ms = 0, gs = null, shadowTris = 0;
  const agl = () => camera.position.y - heightAt(camera.position.x, camera.position.z);

  const perf = ctx.harness ? null : new PerfPanel(() => ({
    gpu: { render: auto.renderMs ?? 0, compute: auto.computeMs ?? 0, total: auto.gpuMs, budget: auto.budget },
    quality: { tau: forest.u.tau.value, auto: auto.on, scale: auto.scale, limited: auto.on && forest.u.tau.value >= auto.maxTau && auto.scale <= 0.5, shadows: ctx.shadowsOn() },
    resolution: { width: size.x, height: size.y, pixelRatio: renderer.getPixelRatio(), msaa: samples, taa: taa.enabled },
    scene: gs && {
      trees: gs.instances + gs.impostors, total: forest.instanceCount, impostors: gs.impostors,
      clusters: gs.barkClusters + gs.leafClusters, swClusters: gs.swClusters ?? 0,
      tris: gs.barkTris + gs.leafTris, swTris: gs.swTris ?? 0, shadowTris,
    },
    camera: {
      x: camera.position.x, z: camera.position.z, agl: agl(), zoom: controls.zoom,
      yaw: THREE.MathUtils.radToDeg(controls.yaw), pitch: THREE.MathUtils.radToDeg(controls.pitch),
    },
    adapter: ctx.adapterName,
  }));

  async function update() {
    gs = await forest.readStats();
    // (the shadow map's casters: on a phone they cost more than the view itself)
    const sh = ctx.shadowsOn() ? await forest.readStats(forest.shadow) : null;
    shadowTris = sh ? sh.barkTris + sh.leafTris : 0;
    const tris = gs.barkTris + gs.leafTris;
    const rows = [
      ...(perf ? [] : [['fps', `${fps.toFixed(0)}   ${ms.toFixed(2)} ms   gpu ${auto.gpuMs.toFixed(2)} ms`]]),
      ['trees', `${(gs.instances + gs.impostors).toLocaleString()} / ${forest.instanceCount.toLocaleString()} visible (${gs.impostors.toLocaleString()} as impostors)`],
      ['altitude', `${Math.round(agl())} m   speed ${Math.round(controls.velocity.length())} m/s`],
      ['clusters', `${(gs.barkClusters + gs.leafClusters).toLocaleString()} (bark ${gs.barkClusters.toLocaleString()}, leaf ${gs.leafClusters.toLocaleString()})`],
      ['triangles', `${(tris / 1e6).toFixed(2)} M   + ${((gs.swTris ?? 0) / 1e6).toFixed(2)} M in software (${(gs.swClusters ?? 0).toLocaleString()} clusters)`],
      ['error', `${forest.u.tau.value.toFixed(2)} px ${auto.on ? `(auto, ${auto.budget} ms budget)` : '(manual)'}${forest.frozen ? '   [CULLING FROZEN]' : ''}`],
      ['debug', `${['off', 'clusters', 'DAG level', 'trees', 'tree types', 'rasterizer'][forest.u.debug.value]}   shadows ${ctx.shadowsOn() ? 'on' : 'off'}   taa ${taa.enabled ? 'on' : 'off'}`],
    ];
    // (labels in the accent colour, numbers bright: the performance panel's style)
    el.innerHTML = rows.map(([k, v]) => `<i>${k.toUpperCase()}</i>${v.replace(/\d[\d,]*(?:\.\d+)?/g, '<b>$&</b>')}`).join('\n');
  }

  return {
    update,
    /** Per displayed frame. */
    frame(now, dt) {
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
    setBenchMs(m) {
      ms = m;
      fps = 1000 / m;
    },
    perf,
  };
}
