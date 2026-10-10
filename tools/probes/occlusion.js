// Occlusion culling counters of the current view (see the two-phase culling in src/nanite/culling.ts and hzb.js):
//   phase1Trees/Tris   drawn in phase 1 (passed last frame's HZB)
//   retestTrees        trees that failed phase 1 (tested again in phase 2)
//   retestClusters     clusters of phase 1 trees that failed (tested again in phase 2)
//   phase2Trees/Tris   drawn in phase 2 (failed phase 1, visible against this frame's HZB)
//   hiddenTrees        trees still hidden after phase 2
//   impostorsDrawn     impostors drawn (in phase 2, after the occluded ones are dropped)
//   hiddenImpostors    impostors dropped as occluded
async (demo) => {
  const f = demo.forest, r = demo.renderer, v = f.main;
  for (let i = 0; i < 3; i++) await demo.renderOnce(); // (phase 1 needs a previous frame's HZB of this view)
  const u32 = async (attr) => new Uint32Array(await r.getArrayBufferAsync(attr));
  // (the view's counters buffer: per set its stats at base + STATS, the retest counts at RETEST; see constants.ts)
  const ctr = await u32(v.ctr.attr), L = f.ctrLayout;
  const stats = (set) => ctr.subarray(set.base + L.STATS, set.base + L.STATS + 5);
  const [retest, a, b] = [ctr.subarray(L.RETEST, L.RETEST + 4), stats(v.sets[0]), stats(v.sets[1])];
  const mtris = (s) => +((s[0] + s[1]) / 1e6).toFixed(2);
  return {
    phase1Trees: a[2],
    phase1MTris: mtris(a),
    retestTrees: retest[0],
    retestClusters: retest[1],
    phase2Trees: b[2],
    phase2MTris: mtris(b),
    hiddenTrees: b[3],
    impostorsDrawn: (await demo.stats()).impostors,
    hiddenImpostors: b[4],
  };
}
