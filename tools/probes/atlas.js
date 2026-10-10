// The impostor atlas (albedo, src/impostors.ts) as a PNG: colour where a tree is, cut-out (alpha < the impostor
// cut-off) shown blue. Side views are the left half, top-down views the right half; render-target textures are
// stored upside down, so trees stand on their heads here.
async (demo) => {
  const rt = demo.atlas.renderTarget;
  const W = rt.width, H = rt.height;
  const raw = await demo.renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
  const half = (v) => {
    const e = (v >> 10) & 31, m = v & 1023;
    const x = e === 0 ? m / 1024 / 16384 : (1 + m / 1024) * 2 ** (e - 15);
    return v & 0x8000 ? -x : x;
  };
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const a = half(raw[i * 4 + 3]);
    for (let k = 0; k < 3; k++) {
      const c = Math.max(0, half(raw[i * 4 + k]) / Math.max(a, 1e-3)) ** (1 / 2.2) * 255; // (unpremultiplied, gamma)
      img.data[i * 4 + k] = a > 0.35 ? Math.min(255, c) : k === 2 ? 255 : 40;
    }
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { size: [W, H], png: canvas.toDataURL() };
}
