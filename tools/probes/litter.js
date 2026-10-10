// The litter map round the camera (src/ground/litter-map.ts): its middle, and at the camera's spot and a few metres
// around it the kind of leaf (0 none, then oak, ash, aspen, pine), the amount fallen and the autumn level.
async (demo) => {
  const m = demo.litter, d = m.texture.image.data, N = m.texture.image.width, size = 256;
  const c = m.center.value, p = demo.camera.position;
  const at = (x, z) => {
    const tx = Math.floor(((x - c.x) / size + 0.5) * N), tz = Math.floor(((z - c.y) / size + 0.5) * N);
    if (tx < 0 || tz < 0 || tx >= N || tz >= N) return null;
    const i = (tz * N + tx) * 4;
    return { kind: d[i], amount: +(d[i + 1] / 255).toFixed(2), level: +((d[i + 2] / 255) * 2).toFixed(2) };
  };
  const kinds = [0, 0, 0, 0, 0];
  for (let i = 0; i < N * N; i++) kinds[d[i * 4]]++;
  return { center: [Math.round(c.x), Math.round(c.y)], here: at(p.x, p.z), around: [[3, 0], [-3, 0], [0, 3], [0, -3]].map(([dx, dz]) => at(p.x + dx, p.z + dz)), kindShare: kinds.map((k) => +(k / N / N).toFixed(3)) };
}
