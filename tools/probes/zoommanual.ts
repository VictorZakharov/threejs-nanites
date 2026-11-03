// A preset or manual tau across the zoom (`--query="auto=0&tau=2"`, src/auto-quality.ts), in the page's loop: tau and the
// clusters zoomed (it should follow the zoom, under the 1M list), tau back unzoomed (what was set); then the same with
// the [ key pressed while zoomed: a tau set by hand stays, through the zoom out.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const u = demo.forest.u, c = demo.controls;
  const clusters = async (): Promise<number> => { const s = await demo.stats(); return s.barkClusters + s.leafClusters; };
  await demo.live(true);
  await sleep(1000);
  const set = u.tau.value;
  c.zoomTarget = c.zoomMax;
  await sleep(1000);
  const zoomed = u.tau.value, zoomedClusters = await clusters();
  c.zoomTarget = 1;
  await sleep(600);
  const back = u.tau.value;
  c.zoomTarget = c.zoomMax;
  await sleep(1000);
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketLeft' }));
  await sleep(100);
  const pressed = u.tau.value;
  c.zoomTarget = 1;
  await sleep(600);
  const kept = u.tau.value;
  await demo.live(false);
  c.zoomTarget = c.zoom = 1;
  return { set, zoomed, zoomedClusters, back, pressed, kept };
}
