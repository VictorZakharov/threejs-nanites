// The culling's fixed-size lists at the current view, per frame over ?capsframes= frames (default 12) with the camera
// still: what's over a cap is dropped in whichever order the threads got there, so a different part of the scene each
// frame (the user: "groups of statues flicker, like appear and disappear"). Per set (phase) `items` of MAX_ITEMS, `bark`
// and `leaf` of LIST_CAP, `trees`; `sw` the software rasterizer's clusters listed of SW_CAP; `retest` the clusters to
// retest of RETEST_CAP. `full` names the lists at their cap in any frame. `swing`: how far the triangles moved over the
// frames, % (nothing moves: it should be ~0). `--query=listguard=0`: with the guard (gpu/list-guard.ts) the lists never stay full.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const f = demo.forest, r = demo.renderer, v = f.main, L = f.ctrLayout;
  const frames = Number(new URLSearchParams(location.search).get('capsframes') ?? 12);
  type Attr = Parameters<typeof r.getArrayBufferAsync>[0];
  const rows: Record<string, number>[] = [], full = new Set<string>();
  for (let i = 0; i < 3; i++) await demo.renderOnce(); // (phase 1 needs a previous frame's HZB of this view)
  for (let i = 0; i < frames; i++) {
    await demo.renderOnce();
    const ctr = new Uint32Array(await r.getArrayBufferAsync(v.ctr.attr as Attr));
    const row: Record<string, number> = { sw: ctr[L.SW], retest: ctr[L.RETEST + 1] };
    let tris = 0;
    v.sets.forEach((s, k) => {
      row[`items${k}`] = ctr[s.base + L.ITEM_COUNT];
      row[`bark${k}`] = ctr[s.base + L.ARGS.bark + 1];
      row[`leaf${k}`] = ctr[s.base + L.ARGS.leaf + 1];
      row[`trees${k}`] = ctr[s.base + L.STATS + 2];
      tris += ctr[s.base + L.STATS] + ctr[s.base + L.STATS + 1];
      if (row[`items${k}`] >= L.MAX_ITEMS) full.add(`items${k}`);
      if (row[`bark${k}`] >= L.LIST_CAP) full.add(`bark${k}`);
      if (row[`leaf${k}`] >= L.LIST_CAP) full.add(`leaf${k}`);
    });
    row.swMTris = +(ctr[L.SW + 1] / 1e6).toFixed(2);
    row.hwMTris = +(tris / 1e6).toFixed(2);
    if (row.sw >= L.SW_CAP) full.add('sw');
    if (row.retest >= L.RETEST_CAP) full.add('retest');
    rows.push(row);
  }
  const swing = (k: string): number => {
    const vs = rows.map((x) => x[k]), hi = Math.max(...vs), lo = Math.min(...vs);
    return hi ? +((100 * (hi - lo)) / hi).toFixed(1) : 0;
  };
  return { tau: f.u.tau.value, full: [...full], swing: { hw: swing('hwMTris'), sw: swing('swMTris'), items: swing('items0'), trees: swing('trees0') }, first: rows[0], last: rows.at(-1) };
}
