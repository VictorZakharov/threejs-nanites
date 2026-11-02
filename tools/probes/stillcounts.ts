// What the culling lists from frame to frame with the camera still, in the page's loop, zoomed, at ?countyaws=a,b,.. (degrees; the
// user: statues flicker side-on to the sun). Nothing moves, so the counts should stand still. For each yaw and view (main, shadow), ?countn=
// (default 40) reads: `tris` distinct values with lowest and highest, `changes` reads that differ from the one before, the same for clusters.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const q = new URLSearchParams(location.search), f = demo.forest, n = Number(q.get('countn') ?? 40);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const sum = (v: number[]) => ({ low: Math.min(...v), high: Math.max(...v), distinct: new Set(v).size, changes: v.filter((x, i) => i && x !== v[i - 1]).length });
  await demo.live(true);
  await sleep(2000);
  demo.controls.zoomTarget = demo.controls.zoomMax;
  await sleep(2000);
  const out: Record<string, unknown> = {};
  for (const y of (q.get('countyaws') ?? '110').split(',').map(Number)) {
    demo.controls.yaw = y * Math.PI / 180;
    await sleep(1500);
    const m: number[] = [], mc: number[] = [], s: number[] = [], sc: number[] = [];
    for (let i = 0; i < n; i++) {
      await new Promise(requestAnimationFrame);
      const a = await f.readStats(), b = await f.readStats(f.shadow);
      m.push(a.barkTris + a.leafTris); mc.push(a.barkClusters + a.leafClusters);
      s.push(b.barkTris + b.leafTris); sc.push(b.barkClusters + b.leafClusters);
    }
    out[y] = { main: { tris: sum(m), clusters: sum(mc) }, shadow: { tris: sum(s), clusters: sum(sc) } };
  }
  await demo.live(false);
  demo.controls.zoomTarget = demo.controls.zoom = 1;
  return out;
}
