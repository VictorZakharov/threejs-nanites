// The [ key pressed until tau is at its minimum, zoomed, in the page's loop (the user: "if I press [ too much, it starts
// flickering like crazy"): every 300 ms for 3 s the guard's factor (src/nanite-lib/gpu/list-guard.ts) and the clusters, then
// the same after zooming out. `?listguard=0`: the clusters sit at the 1M list's cap.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const f = demo.forest, c = demo.controls;
  const rows = async (): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const s = await demo.stats();
      out.push(`x${f.mainGuard.scale.toFixed(2)} ${s.barkClusters + s.leafClusters}`);
    }
    return out;
  };
  await demo.live(true);
  await sleep(1000);
  c.zoomTarget = c.zoomMax;
  await sleep(1000);
  for (let i = 0; i < 12; i++) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketLeft' }));
  const tau = f.u.tau.value, zoomed = await rows();
  c.zoomTarget = 1;
  await sleep(600);
  const out = await rows();
  await demo.live(false);
  c.zoomTarget = c.zoom = 1;
  return { tau, zoomed, out };
}
