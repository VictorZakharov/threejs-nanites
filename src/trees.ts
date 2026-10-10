import { Tree, Billboard } from '@dgreenheck/ez-tree';

// Tree variants: ez-tree preset, seed, target height (m), and its textures. impGain: the impostor colour gains
// (side and top-down views), measured against the real trees with `npm run harness -- --typematch`.
export const VARIANTS = [
  { preset: 'Oak Large', seed: 1234, height: 22, bark: 'oak', leaf: 'oak', impGain: { side: [0.85, 0.74, 0.97], top: [0.78, 0.66, 0.83] } },
  { preset: 'Oak Medium', seed: 77, height: 15, bark: 'oak', leaf: 'oak', impGain: { side: [0.7, 0.61, 0.88], top: [0.69, 0.68, 0.55] } },
  { preset: 'Ash Large', seed: 4242, height: 24, bark: 'birch', leaf: 'ash', impGain: { side: [0.96, 0.78, 1.27], top: [0.97, 0.76, 1.5] } },
  { preset: 'Aspen Medium', seed: 9001, height: 18, bark: 'birch', leaf: 'aspen', impGain: { side: [0.67, 0.42, 0.49], top: [0.66, 0.47, 0.31] } },
  { preset: 'Pine Large', seed: 31337, height: 26, bark: 'pine', leaf: 'pine', impGain: { side: [0.98, 0.75, 1.08], top: [0.85, 0.58, 0.63] } },
  { preset: 'Pine Medium', seed: 555, height: 17, bark: 'pine', leaf: 'pine', impGain: { side: [0.92, 0.66, 0.91], top: [0.62, 0.4, 0.33] } },
];

/** Generates the source meshes of one variant with ez-tree, scaled to metres. */
export function generateTree(variant) {
  const tree = new Tree();
  tree.loadPreset(variant.preset);
  tree.options.seed = variant.seed;
  tree.generate();
  const b = tree.branches, l = tree.leaves;

  let maxY = 0;
  for (let i = 1; i < b.verts.length; i += 3) maxY = Math.max(maxY, b.verts[i]);
  for (let i = 1; i < l.verts.length; i += 3) maxY = Math.max(maxY, l.verts[i]);
  const s = variant.height / maxY;

  const tex = tree.options.bark.textureScale;
  const bark = {
    pos: Float32Array.from(b.verts, (v) => v * s),
    nrm: Float32Array.from(b.normals),
    uv: Float32Array.from(b.uvs, (v, i) => (i % 2 === 0 ? v * tex.x : v / tex.y)),
    idx: Uint32Array.from(b.indices),
  };

  // Leaf normals: blend the card normal with the direction away from the crown centre, so the canopy shades as a
  // volume instead of as flat cards.
  const lpos = Float32Array.from(l.verts, (v) => v * s);
  const n = lpos.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += lpos[i * 3]; cy += lpos[i * 3 + 1]; cz += lpos[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  const lnrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let x = lpos[i * 3] - cx, y = (lpos[i * 3 + 1] - cy) * 1.4 + 0.3 * variant.height, z = lpos[i * 3 + 2] - cz;
    const len = Math.hypot(x, y, z) || 1;
    x /= len; y /= len; z /= len;
    let nx = l.normals[i * 3] ?? 0, ny = l.normals[i * 3 + 1] ?? 1, nz = l.normals[i * 3 + 2] ?? 0;
    // card normals point either way: take the side facing outward
    if (nx * x + ny * y + nz * z < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const mx = x * 0.8 + nx * 0.2, my = y * 0.8 + ny * 0.2, mz = z * 0.8 + nz * 0.2;
    const ml = Math.hypot(mx, my, mz) || 1;
    lnrm[i * 3] = mx / ml; lnrm[i * 3 + 1] = my / ml; lnrm[i * 3 + 2] = mz / ml;
  }
  const leaves = {
    pos: lpos,
    nrm: lnrm,
    uv: Float32Array.from(l.uvs),
    vpl: tree.options.leaves.billboard === Billboard.Double ? 8 : 4,
  };

  // bounding radius around the trunk axis + height, for instance culling
  let r = 0;
  for (const p of [bark.pos, lpos]) for (let i = 0; i < p.length; i += 3) r = Math.max(r, Math.hypot(p[i], p[i + 1] - variant.height / 2, p[i + 2]));
  return { bark, leaves, radius: r, height: variant.height };
}

/**
 * Generates every variant and builds its cluster DAG in a worker. Each worker starts as soon as its tree is grown, so
 * the DAG builds overlap the (main-thread) generation of the next trees. `ui` is the LoadingScreen.
 */
export async function buildAllTrees(ui) {
  const n = VARIANTS.length;
  let done = 0;
  const jobs = [];
  for (let id = 0; id < n; id++) {
    const v = VARIANTS[id];
    await ui.update(0.06 + (0.24 * id) / n, `Growing ${v.preset}`, false);
    const t = performance.now();
    const src = generateTree(v);
    const tris = (src.bark.idx.length + (src.leaves.pos.length / 3 / 4) * 6) / 3;
    ui.note(`Grew ${v.preset}: ${Math.round(tris).toLocaleString()} triangles, ${v.height} m (${Math.round(performance.now() - t)} ms)`);
    jobs.push(
      new Promise((resolve, reject) => {
        const w = new Worker(new URL('./dag-worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e) => {
          w.terminate();
          if (e.data.error) return reject(new Error(e.data.error));
          const st = e.data.stats;
          done++;
          ui.update(0.3 + (0.45 * done) / n, `Cluster DAGs ${done}/${n}`, false);
          ui.note(
            `DAG ${v.preset}: ${(st.barkClusters + st.leafClusters).toLocaleString()} clusters, ` +
              `${Math.max(st.barkLevels, st.leafLevels) + 1} levels (${st.ms} ms)`,
          );
          resolve({ ...e.data, radius: src.radius, height: src.height, variant: v, src });
        };
        w.onerror = (e) => reject(new Error(e.message));
        w.postMessage({ id, bark: src.bark, leaves: src.leaves });
      }),
    );
  }
  await ui.update(0.3, 'Building cluster DAGs in workers', false);
  return Promise.all(jobs);
}
