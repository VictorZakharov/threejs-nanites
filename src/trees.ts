import type { BarkSource, DagReply, DagResult, LeafMask, LeafSource } from './dag-types.ts';
import type { LoadingScreen } from './loading.ts';
import { loadModel, type ModelHeader } from './models.ts';

type RGB = [number, number, number];
export interface TreeVariant {
  preset: string;
  seed: number;
  height: number;
  bark: string;
  leaf: string; // ('none': a model)
  /** A model file (tools/nanite-model.ts) instead of an ez-tree preset: any high-poly mesh, as a variant. */
  model?: string;
  /** Impostor colour gains for side and top-down views. */
  impGain: { side: RGB; top: RGB };
  /** Impostor coverage scale for side and top-down views (impostorCov in src/nanite/billboards.ts). */
  impCov: [number, number];
}
/** One variant's source meshes (metres) and its bounding radius around the trunk axis. */
export interface TreeSource {
  bark: BarkSource;
  leaves: LeafSource;
  radius: number;
  height: number;
}
/** A variant with its cluster DAG, ready for the renderer. */
export interface BuiltTree extends DagResult {
  radius: number;
  height: number;
  variant: TreeVariant;
  src: TreeSource;
  /**
   * A model still downloading (its arrays are empty, its radius a bound from the header): the sizes the forest
   * reserves for it in its buffers, and the model once it's in (NaniteForest.fillType).
   */
  later?: { verts: number; indices: number; clusters: number; tree: Promise<BuiltTree> };
}

/** A bound on a model's radius around its axis from its header's box (positions at height 1, base at y = 0). */
function boundRadius(h: ModelHeader, height: number): number {
  let r = 0;
  for (const x of [h.lo[0], h.hi[0]]) for (const y of [h.lo[1], h.hi[1]]) for (const z of [h.lo[2], h.hi[2]]) r = Math.max(r, Math.hypot(x, y - 0.5, z));
  return r * height;
}

// Tree variants: ez-tree preset, seed, target height (m), and its textures. impGain: the impostor colour gains
// (side and top-down views), measured against the real trees with `npm run harness -- --typematch`.
export const VARIANTS: TreeVariant[] = [
  { preset: 'Oak Large', seed: 1234, height: 22, bark: 'oak', leaf: 'oak', impGain: { side: [0.58, 0.5, 0.62], top: [1.12, 1.07, 0.99] }, impCov: [0.8, 0.6] },
  { preset: 'Oak Medium', seed: 77, height: 15, bark: 'oak', leaf: 'oak', impGain: { side: [0.73, 0.67, 0.91], top: [0.93, 0.82, 0.78] }, impCov: [1, 1] },
  { preset: 'Ash Large', seed: 4242, height: 24, bark: 'birch', leaf: 'ash', impGain: { side: [0.87, 0.74, 1.1], top: [0.96, 1.01, 0.58] }, impCov: [1, 1] },
  { preset: 'Aspen Medium', seed: 9001, height: 18, bark: 'birch', leaf: 'aspen', impGain: { side: [0.94, 0.92, 1.75], top: [0.69, 0.65, 0.71] }, impCov: [1, 1] },
  { preset: 'Pine Large', seed: 31337, height: 26, bark: 'pine', leaf: 'pine', impGain: { side: [0.91, 0.74, 1.24], top: [1.08, 1.01, 0.62] }, impCov: [1, 1] },
  { preset: 'Pine Medium', seed: 555, height: 17, bark: 'pine', leaf: 'pine', impGain: { side: [1.27, 0.86, 1.96], top: [0.64, 0.66, 0.33] }, impCov: [1, 1] },
  // undergrowth (placeBushes): ez-tree's bush presets
  { preset: 'Bush 1', seed: 11, height: 1.8, bark: 'oak', leaf: 'ash', impGain: { side: [1.34, 0.96, 1.63], top: [0.67, 0.56, 0.96] }, impCov: [1, 0.6] },
  { preset: 'Bush 2', seed: 23, height: 2.3, bark: 'oak', leaf: 'oak', impGain: { side: [1.25, 0.85, 1.57], top: [0.6, 0.47, 0.59] }, impCov: [1, 0.8] },
  { preset: 'Bush 3', seed: 37, height: 1.4, bark: 'oak', leaf: 'pine', impGain: { side: [2.03, 1.42, 2.55], top: [1.03, 0.73, 0.89] }, impCov: [1, 0.6] },
  // a model through the same pipeline (placeStatues): Stanford's Lucy scan, decimated to 1M triangles
  // (tools/nanite-model.ts; credit: Stanford Computer Graphics Laboratory, non-commercial use)
  { preset: 'Lucy', seed: 0, height: 4, bark: 'stone', leaf: 'none', model: 'models/lucy.nm', impGain: { side: [1, 1, 1], top: [1, 1, 1] }, impCov: [1, 1] },
];

/** Bushes are variants too (same cluster LOD, impostors and shadows); the tree scatter leaves them out. */
export const isBush = (v: TreeVariant): boolean => v.preset.startsWith('Bush');
/** Models (statues): no leaves, no wind, not in the canopy or the litter. */
export const isModel = (v: TreeVariant): boolean => Boolean(v.model);


/**
 * Grows every variant and builds its cluster DAG, each in its own worker (dag-worker.ts), all at once; the models'
 * DAGs come prebuilt in their files. `ui` is the LoadingScreen.
 */
export async function buildAllTrees(ui: LoadingScreen, leafMask: (leaf: string) => Promise<LeafMask | null>): Promise<BuiltTree[]> {
  const n = VARIANTS.length;
  let done = 0;
  const q = new URLSearchParams(location.search);
  const t0 = performance.now();
  const finished = (): void => void ui.update(0.06 + (0.69 * ++done) / n, `Trees and cluster DAGs ${done}/${n}`, false);
  const jobs = VARIANTS.map(async (v, id): Promise<BuiltTree> => {
    if (v.model) {
      // a model's DAG comes prebuilt in its file (tools/nanite-model.ts): nothing to build. Lucy's is ~5 MB: only its
      // header is waited for, the forest fills the model in when it's arrived (the statues may come after the first
      // frame on a slow connection)
      const { header, model } = loadModel(`./${v.model}`, v.height);
      const delay = Number(q.get('modeldelay') ?? 0); // (debug: a slow download, ms)
      const tree = model.then((m) => new Promise<typeof m>((r) => setTimeout(() => r(m), delay))).then(({ dag, src }): BuiltTree => {
        ui.note(`Loaded ${v.preset}: ${dag.stats.barkTris.toLocaleString()} triangles, ${dag.stats.barkClusters.toLocaleString()} clusters, ${v.height} m (done ${Math.round(performance.now() - t0)} ms in)`);
        return { ...dag, id, radius: src.radius, height: src.height, variant: v, src };
      });
      tree.catch(() => {}); // (surfaces where the forest awaits it)
      const h = await header;
      finished();
      const none = new Float32Array(0);
      return {
        id, vtx: none, idx: new Uint32Array(0), rec: none, meta: new Uint32Array(0), stats: { ...h.stats, ms: 0 },
        radius: boundRadius(h, v.height), height: v.height, variant: v,
        src: { bark: { pos: none, nrm: none, uv: none, idx: new Uint32Array(0) }, leaves: { pos: none, nrm: none, uv: none, vpl: 4 }, radius: 0, height: v.height },
        later: { verts: h.vertices, indices: h.indices, clusters: h.clusters, tree },
      };
    }
    return new Promise<BuiltTree>((resolve, reject) => {
      // the worker grows the tree (tree-grow.ts) and builds its DAG
      const w = new Worker(new URL('./dag-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<DagReply>) => {
        w.terminate();
        if ('error' in e.data) return reject(new Error(e.data.error));
        const st = e.data.stats, src = e.data.src!;
        const tris = (src.bark.idx.length + (src.leaves.pos.length / 3 / 4) * 6) / 3;
        ui.note(
          `Grew ${v.preset} (${Math.round(tris).toLocaleString()} triangles, ${v.height} m, ${Math.round(e.data.growMs ?? 0)} ms) and its DAG: ` +
            `${(st.barkClusters + st.leafClusters).toLocaleString()} clusters, ` +
            `${Math.max(st.barkLevels, st.leafLevels) + 1} levels, leaf growth ${st.leafGrowth.slice(1).map((g) => g.toFixed(2)).join(' ')} (${st.ms} ms)`,
        );
        finished();
        resolve({ ...e.data, radius: src.radius, height: src.height, variant: v, src });
      };
      w.onerror = (e) => reject(new Error(e.message));
      const leafErr = Number(q.get('leaferr') ?? NaN), barkAttr = (q.get('barkattr') ?? '').split(',').filter(Boolean).map(Number);
      const attr = barkAttr.length ? { barkAttr: [barkAttr[0], barkAttr[1] ?? barkAttr[0]] } : {};
      const barkErr = q.get('barkerr') === 'sum' ? { barkErr: 'sum' } : {};
      w.postMessage({ id, grow: v, ...(leafErr > 0 ? { leafErr } : {}), ...attr, ...barkErr });
      // the leaf texture's alpha, for the leaf levels' coverage (dag-coverage.ts; ?leafcover=0: they keep the area
      // instead), sent when it's loaded
      (q.get('leafcover') === '0' ? Promise.resolve(null) : leafMask(v.leaf)).then((m) => w.postMessage(m), reject);
    });
  });
  await ui.update(0.06, 'Growing trees and building their cluster DAGs in workers', false);
  return Promise.all(jobs);
}
