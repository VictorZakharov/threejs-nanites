// What the live loop's GPU timers cover (auto quality steers by them): for ?timersecs= (5) s of the page's own loop, the
// timed passes of the last resolved frame (three's timestamp pool: render and compute), their count and sum, against
// auto.gpuMs. On the AMD PC the live gpuMs read ~26 ms at the spawn at FullHD where the harness's frame-by-frame resolve
// read ~53 and frames took ~55 from submit to done.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const secs = Number(new URLSearchParams(location.search).get('timersecs') ?? 5);
  await demo.live(true);
  await new Promise((r) => setTimeout(r, secs * 1000));
  await demo.live(false);
  const pools = (demo.renderer.backend as unknown as { timestampQueryPool: Record<string, { timestamps: Map<string, number>; frames: number[]; lastValue: number }> }).timestampQueryPool;
  const out: Record<string, unknown> = { gpuMs: +demo.auto.gpuMs.toFixed(2), queueMs: +(demo.auto.queueMs ?? 0).toFixed(2) };
  for (const k of ['render', 'compute']) {
    const p = pools[k];
    const all = [...p.timestamps.entries()];
    const last = p.frames[p.frames.length - 1];
    const ofLast = all.filter(([u]) => u.endsWith(`:f${last}`));
    out[k] = {
      frames: p.frames,
      lastValue: +p.lastValue.toFixed(2),
      passesInLast: ofLast.length,
      passesAll: all.length,
      sumAll: +all.reduce((a, [, d]) => a + d, 0).toFixed(2),
      top: ofLast.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u, d]) => `${u} ${d.toFixed(2)}`),
    };
  }
  return out;
}
