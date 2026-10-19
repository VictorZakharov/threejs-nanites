// Builds the forest floor's maps (floor-maps.ts) or one kind's fallen-leaf layer (floor-leaves.ts) off the main
// thread, so the loading screen stays live: one worker each, in parallel (one worker for all five took ~5 s).
import { forestFloor } from './floor-maps.ts';
import { leafLayer, LEAF_KINDS } from './floor-leaves.ts';

self.onmessage = (e: MessageEvent<{ leaf: number | null; size: number }>) => {
  const post = (msg: unknown, transfer: Transferable[]): void => (self as unknown as Worker).postMessage(msg, transfer);
  const { leaf, size } = e.data;
  const t = performance.now(); // (the work's own time: the loading log)
  if (leaf === null) {
    const d = forestFloor();
    post({ out: d, ms: performance.now() - t }, [d.albedo.buffer, d.normal.buffer, d.rough.buffer]);
  } else {
    const px = leafLayer(LEAF_KINDS[leaf], size, 41 + leaf * 100);
    post({ out: px, ms: performance.now() - t }, [px.buffer]);
  }
};
