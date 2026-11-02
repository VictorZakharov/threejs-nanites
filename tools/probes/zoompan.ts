// Panning while zoomed against holding still, in the page's loop (auto quality as ?auto= says; the user: "panning drops
// FPS"): ?pansec= (default 4) seconds of each. For each: frames, frame ms median / p95 / p99 / longest, frames over 25 and
// 50 ms, GPU ms render and compute (medians), clusters and triangles at the end. `tau` and the lists' guard at the end.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const q = new URLSearchParams(location.search);
  const rate = Number(q.get('panrate') ?? 0.2), secs = Number(q.get('pansec') ?? 4), c = demo.controls;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const med = (v: number[]): number => +(([...v].sort((a, b) => a - b)[v.length >> 1] ?? 0).toFixed(2));
  await demo.live(true);
  await sleep(3000);
  c.zoomTarget = Number(q.get('panzoom') ?? c.zoomMax);
  await sleep(3000);
  const render: number[] = [], compute: number[] = [];
  demo.auto.onSample = (r: number, cp: number): void => { render.push(r); compute.push(cp); };
  const run = async (pan: boolean) => {
    render.length = compute.length = 0;
    const ms: number[] = [];
    const t0 = performance.now();
    let last = t0, dir = 1;
    await new Promise<void>((done) => {
      const tick = (): void => {
        const now = performance.now();
        ms.push(now - last);
        if (pan) {
          c.yaw += dir * rate * (now - last) / 1000;
          if (q.get('panback') !== '0' && (now - t0) % 2000 < (now - last)) dir = -dir; // (back and forth: the same statues; ?panback=0: on round)
        }
        last = now;
        if (now - t0 < secs * 1000) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    const sorted = [...ms].sort((a, b) => a - b), s = await demo.stats();
    return {
      frames: ms.length, median: med(ms), p95: +sorted[Math.floor(ms.length * 0.95)].toFixed(1), p99: +sorted[Math.floor(ms.length * 0.99)].toFixed(1), longest: +sorted.at(-1)!.toFixed(1),
      over25: ms.filter((m) => m > 25).length, over50: ms.filter((m) => m > 50).length, render: med(render), compute: med(compute),
      clusters: s.barkClusters + s.leafClusters, mtris: +((s.barkTris + s.leafTris) / 1e6).toFixed(1),
    };
  };
  const still = await run(false), pan = await run(true), still2 = await run(false);
  demo.auto.onSample = undefined;
  await demo.live(false);
  const tau = demo.forest.u.tau.value, guard = demo.forest.mainGuard.scale;
  c.zoomTarget = c.zoom = 1;
  return { tau, guard, still, pan, still2 };
}
