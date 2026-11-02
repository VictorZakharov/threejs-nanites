// What the 5x zoom looks like frame by frame, in the page's own loop with auto quality on (--zoomtime's screenshots take
// over a second each, so they can't see the second after the zoom; the user: wings change "~1sec after"). 5 s unzoomed,
// then the zoom, then ?filmms= (default 3000) of the middle of the canvas copied each frame. `rows` every ?filmstep= ms
// (default 100): time since the zoom (ms), zoom, tau, scale, shadow half-extent, px over 24/255 against the last frame of
// the film, the same against the frame before. `png`: frames across the film side by side, time labels in `shots`.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const q = new URLSearchParams(location.search);
  const filmMs = Number(q.get('filmms') ?? 3000), stepMs = Number(q.get('filmstep') ?? 100), W = 480, H = 270;
  const canvas = demo.renderer.domElement as HTMLCanvasElement;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const sx = (canvas.width - W) >> 1, sy = (canvas.height - H) >> 1;
  await demo.live(true);
  await new Promise((r) => setTimeout(r, 5000));
  const frames: { t: number; zoom: number; d: Uint8ClampedArray }[] = [];
  const t0 = performance.now();
  demo.controls.zoomTarget = demo.controls.zoomMax;
  await new Promise<void>((done) => {
    const grab = (): void => {
      // (in the frame's own task: the canvas is still valid; this callback runs after the loop's, which was registered first)
      ctx.drawImage(canvas, sx, sy, W, H, 0, 0, W, H);
      frames.push({ t: performance.now() - t0, zoom: demo.controls.zoom, d: ctx.getImageData(0, 0, W, H).data });
      if (performance.now() - t0 < filmMs) requestAnimationFrame(grab);
      else done();
    };
    requestAnimationFrame(grab);
  });
  const log = (await demo.live(false)) as number[][];
  demo.controls.zoomTarget = demo.controls.zoom = 1;
  const last = frames[frames.length - 1].d;
  const over = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 24 || Math.abs(a[i + 1] - b[i + 1]) > 24 || Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
    return n;
  };
  const logT0 = (log.at(-1)?.[0] ?? 0) - (performance.now() - t0);
  const rows: string[] = [], shots: number[] = [];
  let next = 0;
  frames.forEach((f, k) => {
    if (f.t < next || !k) return;
    next += stepMs;
    const l = log.find((e) => e[0] - logT0 >= f.t) ?? log[log.length - 1];
    rows.push(`${f.t.toFixed(0)}ms z${f.zoom.toFixed(3)} tau${l[1]} s${l[2]} half${l[5]} last${over(f.d, last)} prev${over(f.d, frames[k - 1].d)}`);
  });
  const dts = frames.slice(1).map((f, k) => f.t - frames[k].t).sort((a, b) => a - b);
  // (the film: 8 frames from the zoom's end to the last)
  const picks = [300, 500, 700, 900, 1100, 1400, 2000, filmMs].map((m) => frames.find((f) => f.t >= m) ?? frames[frames.length - 1]);
  const sheet = document.createElement('canvas');
  sheet.width = W * 4; sheet.height = H * 2;
  const sc = sheet.getContext('2d')!;
  picks.forEach((f, i) => {
    sc.putImageData(new ImageData(new Uint8ClampedArray(f.d), W, H), (i % 4) * W, (i >> 2) * H);
    shots.push(Math.round(f.t));
  });
  return { frames: frames.length, medianFrameMs: +dts[dts.length >> 1].toFixed(1), rows, shots, png: sheet.toDataURL('image/png') };
}
