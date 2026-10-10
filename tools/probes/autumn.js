// Autumn (src/autumn.ts): the share of broadleaf trees per level (green / yellow / red) and, per level, the nearest
// spot to the origin standing in a stand of it (most of the broadleaf trees within 20 m of that level), for views.
async (demo) => {
  const { a, b, trees } = demo.instances;
  const level = (i) => Math.floor(b[i * 4 + 3] / (Math.PI * 2)) / 7.5;
  const cls = (v) => (v < 0.5 ? 'green' : v < 1.4 ? 'yellow' : 'red');
  const share = { green: 0, yellow: 0, red: 0 }, spots = {};
  // (pines count as green)
  const near = [];
  for (let i = 0; i < trees; i++) {
    share[cls(level(i))]++;
    if (Math.hypot(a[i * 4], a[i * 4 + 2]) < 1500) near.push(i);
  }
  for (const want of ['green', 'yellow', 'red']) {
    let best = null;
    for (const i of near) {
      if (cls(level(i)) !== want) continue;
      const x = a[i * 4], z = a[i * 4 + 2];
      let same = 0, all = 0;
      for (const j of near) {
        if (Math.abs(a[j * 4] - x) > 20 || Math.abs(a[j * 4 + 2] - z) > 20) continue;
        all++;
        if (cls(level(j)) === want) same++;
      }
      const score = all >= 6 ? same / all : 0;
      const d = Math.hypot(x, z);
      if (!best || score > best.score + 0.05 || (Math.abs(score - best.score) <= 0.05 && d < best.d)) best = { x: Math.round(x), z: Math.round(z), score: +score.toFixed(2), d: Math.round(d), all };
    }
    // the cover map there (src/placement.ts forestDensity): cover, fallen leaves' amount, their level / 2
    const m = demo.coverMap, N = m.texture.image.width, d = m.texture.image.data;
    const px = Math.floor((best.x / (m.extent * 2) + 0.5) * N), pz = Math.floor((best.z / (m.extent * 2) + 0.5) * N);
    best.map = [0, 1, 2].map((c) => +(d[(pz * N + px) * 4 + c] / 255).toFixed(2));
    spots[want] = best;
  }
  return { share, spots };
}
