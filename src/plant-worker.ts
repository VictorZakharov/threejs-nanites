// Plants a share of the forest's tiles (planting.ts) off the main thread, posting each tile as it's done.
import { plantTile, type PlantConfig, type TilePlants } from './planting.ts';

export interface PlantRequest {
  cfg: PlantConfig;
  tiles: number[];
}
export type PlantReply = TilePlants | { done: true } | { error: string };

// (typed as a worker scope: the project's lib is the DOM's, where `self` is the window)
const scope = self as unknown as { onmessage: (e: MessageEvent<PlantRequest>) => void; postMessage(msg: PlantReply, transfer?: Transferable[]): void };
scope.onmessage = (e) => {
  try {
    for (const t of e.data.tiles) {
      const r = plantTile(e.data.cfg, t);
      scope.postMessage(r, [r.trees.buffer, r.bushes.buffer]);
    }
    scope.postMessage({ done: true });
  } catch (err) {
    scope.postMessage({ error: String(err instanceof Error ? (err.stack ?? err) : err) });
  }
};
