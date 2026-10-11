// The litter map round the camera (src/ground/litter-map.ts): its middle, and at the camera's spot and a few metres
// around it the kind of leaf (0 none, then oak, ash, aspen, pine), the amount fallen and the autumn level; and how
// long a whole rebuild takes on the main thread (every 32 m walked; the frame loop spreads it over frames).
async (demo) => {
  const m = demo.litter, d = m.texture.image.data, N = m.texture.image.width, size = 256;
  const c = m.center.value, p = demo.camera.position;
  const at = (x, z) => {
    const tx = Math.floor(((x - c.x) / size + 0.5) * N), tz = Math.floor(((z - c.y) / size + 0.5) * N);
    if (tx < 0 || tz < 0 || tx >= N || tz >= N) return null;
    const i = (tz * N + tx) * 4;
    return { kind: d[i], amount: +(d[i + 1] / 255).toFixed(2), level: +((d[i + 2] / 255) * 2).toFixed(2) };
  };
  // (a whole rebuild, three times; the frame loop does it in slices of a few ms)
  const times = [];
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    m.rebuildNow(p.x, p.z);
    times.push(performance.now() - t);
  }
  // as the frame loop does it: 40 m on, one update a frame until the map has moved there (frames, longest slice)
  const slices = [];
  while (slices.length < 500 && Math.abs(m.center.value.x - (p.x + 40)) > 1) {
    const t = performance.now();
    m.update({ x: p.x + 40, z: p.z }, 2);
    slices.push(performance.now() - t);
  }
  const sliced = { frames: slices.length, longestMs: +Math.max(...slices).toFixed(1) };
  m.rebuildNow(p.x, p.z);
  const kinds = [0, 0, 0, 0, 0];
  for (let i = 0; i < N * N; i++) kinds[d[i * 4]]++;
  return { rebuildMs: times.map((t) => +t.toFixed(1)), sliced, center: [Math.round(c.x), Math.round(c.y)], here: at(p.x, p.z), around: [[3, 0], [-3, 0], [0, 3], [0, -3]].map(([dx, dz]) => at(p.x + dx, p.z + dz)), kindShare: kinds.map((k) => +(k / N / N).toFixed(3)) };
}
