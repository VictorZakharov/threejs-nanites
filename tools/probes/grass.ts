// The grass's keep passes (src/grass-keep.ts): per ring the cells tested this frame (the tiles in view), the blades
// kept and drawn, and the list's size (blades past it are dropped: `kept` should stay well under `cap`).
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  demo.renderOnce();
  return await demo.grass.stats();
}
