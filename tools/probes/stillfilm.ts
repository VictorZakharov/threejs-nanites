// The camera still in the page's loop (zoomed by ?filmzoom=, default the maximum): ?filmframes= (default 32) consecutive frames of the
// whole canvas, pixel by pixel (--dolly's 16 px tiles average small statues away; the user: "it flickers on the statue
// itself"). `over`: pixels whose brightness ranges over ?filmover= (default 24)/255 across the film; `worst`: the 32 px tile with the
// most of them, x, y and count; its frames in `png`'s top rows, 6x, then the whole screen's range x4. ?filmyaws=a,b,..
// (degrees): `yaws` lists `over` at each first, the last being the one filmed for the rest (the user: it depends on the angle to the sun).
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const q = new URLSearchParams(location.search);
  const n = Number(q.get('filmframes') ?? 32), limit = Number(q.get('filmover') ?? 24), z = Number(q.get('filmzoom') ?? demo.controls.zoomMax);
  const canvas = demo.renderer.domElement as HTMLCanvasElement, W = canvas.width, H = canvas.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  await demo.live(true);
  await new Promise((r) => setTimeout(r, 2000));
  demo.controls.zoomTarget = z;
  await new Promise((r) => setTimeout(r, 3000));
  let frames: Uint8ClampedArray[] = [];
  const film = async (): Promise<void> => {
    frames = [];
    await new Promise<void>((done) => {
      const grab = (): void => {
        ctx.drawImage(canvas, 0, 0);
        frames.push(ctx.getImageData(0, 0, W, H).data);
        if (frames.length < n) requestAnimationFrame(grab); else done();
      };
      requestAnimationFrame(grab);
    });
  };
  const lum = (d: Uint8ClampedArray, i: number): number => d[i] * 0.3 + d[i + 1] * 0.6 + d[i + 2] * 0.1;
  const range = new Uint8ClampedArray(W * H);
  const measure = (): number => {
    let count = 0;
    for (let p = 0; p < W * H; p++) {
      let lo = 255, hi = 0;
      for (const f of frames) { const l = lum(f, p * 4); if (l < lo) lo = l; if (l > hi) hi = l; }
      range[p] = hi - lo;
      if (range[p] > limit) count++;
    }
    return count;
  };
  const yaws: Record<string, number> = {};
  for (const y of q.get('filmyaws')?.split(',').map(Number) ?? [NaN]) {
    if (!Number.isNaN(y)) {
      demo.controls.yaw = y * Math.PI / 180;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await film();
    yaws[y] = measure();
  }
  const tau = demo.forest.u.tau.value;
  await demo.live(false);
  demo.controls.zoomTarget = demo.controls.zoom = 1;
  const TILE = 32, tiles = new Map<number, number>();
  let over = 0;
  for (let p = 0; p < W * H; p++) if (range[p] > limit) {
    over++;
    const k = ((p / W) | 0) / TILE | 0, t = k * 65536 + ((p % W) / TILE | 0);
    tiles.set(t, (tiles.get(t) ?? 0) + 1);
  }
  const top = [...tiles].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  const tx = (top[0] % 65536) * TILE, ty = Math.floor(top[0] / 65536) * TILE, S = 6, show = 8;
  const sheet = document.createElement('canvas');
  sheet.width = Math.max(W, show * TILE * S); sheet.height = TILE * S + H;
  const sc = sheet.getContext('2d')!;
  sc.imageSmoothingEnabled = false;
  for (let i = 0; i < show; i++) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(frames[i * 2 % n]), W, H), 0, 0);
    sc.drawImage(c, tx, ty, TILE, TILE, i * TILE * S, 0, TILE * S, TILE * S);
  }
  const img = new ImageData(W, H);
  for (let p = 0; p < W * H; p++) { img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = Math.min(255, range[p] * 4); img.data[p * 4 + 3] = 255; }
  sc.putImageData(img, 0, TILE * S);
  return { tau, yaws, over, tiles: tiles.size, worst: [tx, ty, top[1]], png: sheet.toDataURL('image/png') };
}
