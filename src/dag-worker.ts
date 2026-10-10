// Builds one mesh's cluster DAG (dag-build.ts) off the main thread.
import { buildDag } from './dag-build.ts';
import type { DagReply, DagRequest } from './dag-types.ts';

// (typed as a worker scope: the project's lib is the DOM's, where `self` is the window)
const scope = self as unknown as { onmessage: (e: MessageEvent<DagRequest>) => void; postMessage(msg: DagReply, transfer?: Transferable[]): void };
scope.onmessage = async (e) => {
  try {
    const r = await buildDag(e.data);
    scope.postMessage(r, [r.vtx.buffer, r.idx.buffer, r.rec.buffer, r.meta.buffer]);
  } catch (err) {
    scope.postMessage({ id: e.data.id, error: String(err instanceof Error ? (err.stack ?? err) : err) });
  }
};
