// What's drawn at each zoom level through the zoom, in the page's loop: use ?zoomms=3000 to ease it slowly (the user: zooming in
// "spikes to 20+ mil triangles, then goes back to 5m"). A row about every 150 ms in and then out: zoom, the fov, tau, triangles (M), clusters,
// trees drawn as geometry, impostors. The LOD goes by tau / zoom, so tau x zoom keeps a statue's cut: nothing should peak mid-way.
// `peak`: the most triangles (M) read each way, as quickly as the readbacks go (at the real 150 ms: a late tau shows here).
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const c = demo.controls, f = demo.forest, cam = demo.camera as { fov: number };
  const ms = Number(new URLSearchParams(location.search).get('zoomms') ?? 150);
  const row = async (): Promise<string> => {
    const s = await f.readStats();
    return `z${c.zoom.toFixed(2)} fov${cam.fov.toFixed(1)} tau${f.u.tau.value.toFixed(2)} ${((s.barkTris + s.leafTris) / 1e6).toFixed(1)}M c${s.barkClusters + s.leafClusters} t${s.instances} i${s.impostors}`;
  };
  await demo.live(true);
  await sleep(Number(new URLSearchParams(location.search).get('sweepwait') ?? 3000)); // (?sweepwait=: for auto quality to settle)
  const rows: string[] = [], peak: number[] = [];
  for (const target of [c.zoomMax, 1]) {
    rows.push('--');
    c.zoomTarget = target;
    const t0 = performance.now();
    let most = 0, next = 0;
    while (performance.now() - t0 < ms + 500) {
      await new Promise(requestAnimationFrame);
      const s = await f.readStats();
      most = Math.max(most, s.barkTris + s.leafTris);
      if (performance.now() - t0 >= next) {
        rows.push(await row());
        next += 150;
      }
    }
    peak.push(+(most / 1e6).toFixed(1));
  }
  await demo.live(false);
  c.zoomTarget = c.zoom = 1;
  return { peak, rows };
}
