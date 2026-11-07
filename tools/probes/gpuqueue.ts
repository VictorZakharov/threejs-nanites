// Frames queued on the GPU, in the page's own loop (`--query=auto=0&...`, `?gpuqueue=0|1`): for ?queuesecs= (10) s after ?queuewait= (3) s, each
// frame's time from its submit to its GPU work done (src/webgpu-start.ts's loop). Past the frame's own GPU time it's frames
// waiting, and the desktop's compositor waits behind them: on the AMD PC's iGPU the mouse moved in jumps. Headless
// presents nothing, but the queue still builds: run it there (npm run remote). `median`/`p95` ms, `gpu` the GPU time, `fps`.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const q = new URLSearchParams(location.search), auto = demo.auto;
  const secs = Number(q.get('queuesecs') ?? 10);
  auto.tuning = true;
  await demo.live(true);
  await new Promise((r) => setTimeout(r, Number(q.get('queuewait') ?? 3) * 1000)); // (settled: ?queuewait= s, 25 with auto quality)
  auto.queueLog = [];
  let frames = 0, run = true;
  const count = (): void => {
    frames++;
    if (run) requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
  await new Promise((r) => setTimeout(r, secs * 1000));
  run = false;
  await demo.live(false);
  const v = [...(auto.queueLog ?? [])].sort((a, b) => a - b);
  const at = (p: number): number => +(v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0).toFixed(1);
  return { frames: v.length, fps: +(v.length / secs).toFixed(1), raf: +(frames / secs).toFixed(1), median: at(0.5), p95: at(0.95), gpu: +auto.gpuMs.toFixed(1),
    // (where auto quality settled: its tier, resolution scale and tau, the scene's and the TAA's sizes, the steps it took)
    behind: +(auto.behindMs ?? 0).toFixed(1), underRead: +(auto.underRead ?? 1).toFixed(2), steer: auto.steer?.map((x) => +x.toFixed(1)), mainMs: +(auto.mainMs ?? 0).toFixed(1), frameMs: +(auto.frameMs ?? 0).toFixed(1),
    tier: auto.tier ?? 0, scale: +auto.scale.toFixed(3), tau: +demo.forest.u.tau.value.toFixed(2), scene: `${demo.sceneRT.width}x${demo.sceneRT.height}`,
    taa: demo.taa.size?.toArray().join('x'), steps: auto.trials,
    // (with --query=perf=1: the report's slow frames by cause, src/slow-frames.ts)
    slow: demo.perfReport()?.split('\n\n').find((b) => b.startsWith('slow frames')) };
}
