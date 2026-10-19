// The WebGL mode's own loop (src/webgl/harness.ts runLoop; run with --query=webgl=1): `?loopms=` (8000) of real
// frames with auto quality on (`?loopauto=0`: off), returning every resolution step and the frames over 50 ms.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const q = new URLSearchParams(location.search);
  const run = demo.loopTest as ((ms: number, on: boolean) => Promise<unknown>) | undefined;
  return run ? run(Number(q.get('loopms') ?? 8000), q.get('loopauto') !== '0') : { error: 'not the WebGL mode (use --query=webgl=1)' };
}
