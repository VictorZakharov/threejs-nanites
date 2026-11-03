// Auto quality's low-end tiers (src/auto-quality.ts) on a GPU that's too fast to need them, in the page's loop (`--query=auto=1`):
// the budget is set out of reach (?lowbudget=, default 0.5 ms) until the last tier, then well above (40 ms) until it's back at
// tier 0. `rows`: every second the time, tier, tau, scale, canvas size and GPU ms. `png`: the canvas at tier 0, 1 and 2,
// side by side in `shots` order.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const q = new URLSearchParams(location.search), auto = demo.auto, W = 640, H = 360;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const canvas = demo.renderer.domElement as HTMLCanvasElement;
  const sheet = document.createElement('canvas');
  sheet.width = W * 3; sheet.height = H;
  const sc = sheet.getContext('2d')!;
  const shots: string[] = [], rows: string[] = [];
  const t0 = performance.now();
  const row = (): void => {
    rows.push(`${((performance.now() - t0) / 1000).toFixed(0)}s tier${auto.tier ?? 0} tau${demo.forest.u.tau.value.toFixed(2)} s${auto.scale.toFixed(2)} out${canvas.width}x${canvas.height} gpu${auto.gpuMs.toFixed(2)}`);
  };
  const shot = async (): Promise<void> => {
    await new Promise<void>((done) => requestAnimationFrame(() => {
      sc.drawImage(canvas, shots.length * W, 0, W, H);
      done();
    }));
    shots.push(`tier${auto.tier ?? 0}`);
  };
  /** Runs until `until`, a row each second; false if it took over `ms`. */
  const wait = async (until: () => boolean, ms: number): Promise<boolean> => {
    const start = performance.now();
    while (!until()) {
      if (performance.now() - start > ms) return false;
      row();
      await sleep(1000);
    }
    return true;
  };
  auto.tuning = true;
  await demo.live(true);
  await sleep(2000);
  await shot();
  auto.budget = Number(q.get('lowbudget') ?? 0.5);
  const up1 = await wait(() => (auto.tier ?? 0) >= 1, 30000);
  await sleep(1500);
  await shot();
  const up2 = await wait(() => (auto.tier ?? 0) >= 2, 15000);
  await sleep(2500);
  await shot();
  row();
  auto.budget = 40;
  const back = await wait(() => (auto.tier ?? 0) === 0, 30000);
  row();
  await demo.live(false);
  return { up1, up2, back, rows, shots, png: sheet.toDataURL('image/png') };
}
