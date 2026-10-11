// Trees and clusters drawn vs seen (needs --query=ids=1): debug 6 writes each pixel's tree and cluster into the scene
// target's second output (src/nanite/draw.ts); this counts the distinct ones on screen against what the culling drew.
// Hardware geometry only (impostors and the software rasterizer aren't in it: on the ground, under 25 m, there's no
// software rasterizer, see swalt). "seenTris": the triangles of the clusters that reach at least one pixel, the most
// any culling could leave.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const f = demo.forest, r = demo.renderer, rt = demo.sceneRT;
  f.u.debug.value = 6;
  await demo.renderOnce();
  const st = await demo.stats();
  const w = rt.width, h = rt.height;
  const px = await r.readRenderTargetPixelsAsync(rt, 0, 0, w, h, 1);
  f.u.debug.value = 0;
  await demo.renderOnce();
  // half floats (small whole numbers here)
  const half = (v: number): number => {
    const e = (v >> 10) & 31, m = v & 1023;
    return e === 0 ? m / 16777216 : (1 + m / 1024) * 2 ** (e - 15);
  };
  const get = px instanceof Uint16Array ? (i: number) => half(px[i]) : (i: number) => px[i];
  const trees = new Map<number, number>(), clusters = new Map<number, number>();
  let treePx = 0;
  for (let p = 0; p < w * h; p++) {
    const a = Math.round(get(p * 4 + 3));
    if (a < 1) continue;
    const inst = Math.round(get(p * 4)) + Math.round(get(p * 4 + 1)) * 2048;
    const c = Math.round(get(p * 4 + 2)) + (a - 1) * 2048;
    treePx++;
    trees.set(inst, (trees.get(inst) ?? 0) + 1);
    const key = inst * 65536 + c;
    clusters.set(key, (clusters.get(key) ?? 0) + 1);
  }
  const cd = f.cData.value.array, meta = new Uint32Array(cd.buffer, cd.byteOffset, cd.length);
  let seenTris = 0;
  for (const key of clusters.keys()) seenTris += meta[(key % 65536) * 20 + 17];
  const atLeast = (m: Map<number, number>, n: number): number => [...m.values()].filter((v) => v >= n).length;
  return {
    size: `${w}x${h}`,
    treePixels: +(treePx / (w * h)).toFixed(3),
    treesDrawn: st.instances,
    treesSeen: trees.size,
    treesSeen10px: atLeast(trees, 10),
    treesSeen100px: atLeast(trees, 100),
    clustersDrawn: st.barkClusters + st.leafClusters,
    clustersSeen: clusters.size,
    trisDrawn: st.barkTris + st.leafTris,
    seenTris,
  };
}
