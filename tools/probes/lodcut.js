// The DAG cut per tree type by its size on screen, on the CPU from the cluster data (independent of the view and the
// GPU): for a tree drawn H px tall at tau (?tau=, the page's), seen from the side at mid height, the bark and leaf
// triangles and clusters of the cut (lod error <= tau < parent error, as in the cluster pass of
// src/nanite/culling.ts) and the triangles per pixel of its height. Answers "why does a 30 px tree cost 1000
// triangles": which part, at which level.
async (demo) => {
  const f = demo.forest, tau = f.u.tau.value;
  const cd = f.cData.value.array, meta = new Uint32Array(cd.buffer, cd.byteOffset, cd.length);
  const S = 20; // floats per cluster (CD_STRIDE vec4s)
  const heights = [10, 20, 30, 50, 100, 200, 400];
  const out = {}, errs = {};
  f.typeInfo.array.forEach((ti, t) => {
    const name = f.stats.types[t].name, h = ti.w, proj = 1000;
    // the median error (m, the tree's own scale) of each level's bark and leaf clusters: what keeps a level on screen
    const lv = {};
    for (let c = ti.x; c < ti.x + ti.y; c++) {
      const o = c * S, k = `${cd[o + 15] < 0.5 ? 'b' : 'l'}${cd[o + 14]}`;
      (lv[k] ??= []).push(cd[o + 12]);
    }
    const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
    errs[name] = Object.keys(lv).sort().map((k) => `${k} ${med(lv[k]).toFixed(3)}`).join(', ');
    out[name] = heights.map((H) => {
      const d = (h * proj) / H, cam = [d, h / 2, 0];
      const err = (o, e) => {
        const dist = Math.max(Math.hypot(cd[o] - cam[0], cd[o + 1] - cam[1], cd[o + 2] - cam[2]) - cd[o + 3], 0.05);
        return (e * proj) / dist;
      };
      let bark = 0, leaf = 0, cb = 0, cl = 0, lvl = 0;
      for (let c = ti.x; c < ti.x + ti.y; c++) {
        const o = c * S;
        if (!(err(o, cd[o + 12]) <= tau && err(o + 4, cd[o + 13]) > tau)) continue;
        const tris = meta[o + 17];
        if (cd[o + 15] < 0.5) (bark += tris), cb++;
        else (leaf += tris), cl++;
        lvl = Math.max(lvl, cd[o + 14]);
      }
      return `${H}px: bark ${bark} (${cb}) leaf ${leaf} (${cl}) lvl<=${lvl}`;
    });
  });
  return { tau, cut: out, levelErr: errs };
}
