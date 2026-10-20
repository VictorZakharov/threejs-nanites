// Builds one mesh's cluster DAG (nanite-lib's buildDag) off the main thread; for a tree variant, grows it first (tree-grow.ts),
// then waits for its leaf mask (a second message).
// (straight from the module, not the library's index: a worker's bundle takes only what it imports)
import { buildDag } from './nanite-lib/dag/build.ts';
import type { LeafMask } from './nanite-lib/dag/types.ts';
import { generateTree } from './tree-grow.ts';
import type { DagJob, DagReply } from './trees.ts';

// (typed as a worker scope: the project's lib is the DOM's, where `self` is the window)
const scope = self as unknown as { onmessage: (e: MessageEvent<DagJob | LeafMask | null>) => void; postMessage(msg: DagReply, transfer?: Transferable[]): void };
// (a tree's leaf mask comes in a second message: the tree grows while the leaf texture loads)
let maskArrived: (m: LeafMask | null) => void = () => {};
const mask = new Promise<LeafMask | null>((r) => (maskArrived = r));
scope.onmessage = async (e) => {
  if (e.data === null || !('id' in e.data)) return maskArrived(e.data);
  const job = e.data;
  try {
    if ('grow' in job) {
      const t = performance.now();
      const src = generateTree(job.grow);
      const growMs = performance.now() - t;
      const leafMask = await mask;
      // (the DAG from a copy: the source meshes go back as they were grown, for the impostor bake)
      const r = await buildDag({ ...job, ...(leafMask ? { leafMask } : {}), bark: structuredClone(src.bark), leaves: structuredClone(src.leaves) });
      const { bark, leaves } = src;
      scope.postMessage({ ...r, src, growMs }, [r.vtx.buffer, r.idx.buffer, r.rec.buffer, r.meta.buffer, bark.pos.buffer, bark.nrm.buffer, bark.uv.buffer, bark.idx.buffer, leaves.pos.buffer, leaves.nrm.buffer, leaves.uv.buffer]);
    } else {
      const r = await buildDag(job);
      scope.postMessage(r, [r.vtx.buffer, r.idx.buffer, r.rec.buffer, r.meta.buffer]);
    }
  } catch (err) {
    scope.postMessage({ id: job.id, error: String(err instanceof Error ? (err.stack ?? err) : err) });
  }
};
