// Auto quality on a slow, noisy GPU, on the dev GPU: `?autosim=x,noise,pixels` scales its GPU samples (src/auto-quality.ts), so what
// each step really saves still counts. The laptop on the ground, --query="auto=1&autosim=3.5,0.3,21", at the budget of a 60 Hz screen (?simbudget=, 13.3):
// `rows`: every 2 s the tier, tau, resolution and GPU ms it sees, for ?simsecs= (50) s; `steps`: its steps and trials.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const q = new URLSearchParams(location.search), auto = demo.auto;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  auto.tuning = true;
  auto.budget = Number(q.get('simbudget') ?? 13.3);
  await demo.live(true);
  const rows: string[] = [], t0 = performance.now(), secs = Number(q.get('simsecs') ?? 50);
  while (performance.now() - t0 < secs * 1000) {
    rows.push(`${((performance.now() - t0) / 1000).toFixed(0)}s tier${auto.tier ?? 0} tau${demo.forest.u.tau.value.toFixed(2)} s${auto.scale.toFixed(2)} out${demo.renderer.domElement.width}x${demo.renderer.domElement.height} gpu${auto.gpuMs.toFixed(1)}`);
    await sleep(2000);
  }
  await demo.live(false);
  return { rows, steps: auto.trials ?? [], remembered: auto.remember ? localStorage.getItem(auto.remember) : null };
}
