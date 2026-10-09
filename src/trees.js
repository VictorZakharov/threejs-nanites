import { Tree, Billboard } from '@dgreenheck/ez-tree';

// Tree variants: ez-tree preset, seed, target height (m), and its textures.
export const VARIANTS = [
  { preset: 'Oak Large', seed: 1234, height: 22, bark: 'oak', leaf: 'oak' },
  { preset: 'Oak Medium', seed: 77, height: 15, bark: 'oak', leaf: 'oak' },
  { preset: 'Ash Large', seed: 4242, height: 24, bark: 'birch', leaf: 'ash' },
  { preset: 'Aspen Medium', seed: 9001, height: 18, bark: 'birch', leaf: 'aspen' },
  { preset: 'Pine Large', seed: 31337, height: 26, bark: 'pine', leaf: 'pine' },
  { preset: 'Pine Medium', seed: 555, height: 17, bark: 'pine', leaf: 'pine' },
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

/** Builds the cluster DAG of every variant in parallel workers. */
export async function buildAllTrees(onProgress) {
  const sources = VARIANTS.map((v) => generateTree(v));
  let done = 0;
  const results = await Promise.all(
    sources.map(
      (src, id) =>
        new Promise((resolve, reject) => {
          const w = new Worker(new URL('./dag-worker.js', import.meta.url), { type: 'module' });
          w.onmessage = (e) => {
            w.terminate();
            if (e.data.error) reject(new Error(e.data.error));
            else {
              onProgress?.(++done, sources.length);
              resolve({ ...e.data, radius: src.radius, height: src.height, variant: VARIANTS[id] });
            }
          };
          w.onerror = (e) => reject(new Error(e.message));
          w.postMessage({ id, bark: src.bark, leaves: src.leaves });
        }),
    ),
  );
  return results;
}
