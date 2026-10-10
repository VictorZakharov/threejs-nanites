// Builds the forest floor's maps (floor-maps.ts) off the main thread, so the loading screen stays live.
import { forestFloor } from './floor-maps.ts';

self.onmessage = () => {
  const d = forestFloor();
  (self as unknown as Worker).postMessage(d, [d.albedo.buffer, d.normal.buffer, d.rough.buffer]);
};
