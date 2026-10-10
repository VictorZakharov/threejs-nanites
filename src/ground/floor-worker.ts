// Builds the forest floor's maps (floor-maps.ts) and the fallen leaves' layers (floor-leaves.ts) off the main thread,
// so the loading screen stays live.
import { forestFloor } from './floor-maps.ts';
import { leafLayers } from './floor-leaves.ts';

self.onmessage = () => {
  const d = forestFloor();
  const leaves = leafLayers(d.size);
  (self as unknown as Worker).postMessage({ ...d, leaves }, [d.albedo.buffer, d.normal.buffer, d.rough.buffer, leaves.buffer]);
};
