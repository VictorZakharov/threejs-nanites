// The WebGL mode's near-tree lists (run with --query=webgl=1): walks the camera 120 m along its heading in 1.5 m
// steps (then turns and walks back), and at each step checks that every tree in a level's band, as the shader works
// it out from the camera, is in that level's list from the last scan (src/webgl/near.ts audit). A tree missing from
// one draws only part of its pixels (see-through under TAA), from both: gone with its shadow. `grown`: lists that were
// full and grew.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const near = demo.glNear;
  if (!near) return { error: 'not the WebGL mode (--query=webgl=1)' };
  near.keepIds();
  const cam = demo.camera, start = cam.position.clone();
  let steps = 0, checked = 0, missing = 0, bad = 0, worst = '';
  for (const back of [false, true]) {
    for (let i = 0; i < 80; i++) {
      const a = demo.controls.yaw + (back ? Math.PI : 0);
      cam.position.x -= Math.sin(a) * 1.5;
      cam.position.z -= Math.cos(a) * 1.5;
      await demo.renderOnce();
      const r = near.audit(cam.position);
      steps++;
      checked += r.checked;
      missing += r.missing;
      if (r.missing) (bad++, (worst ||= `step ${steps}: ${r.worst}`));
    }
  }
  cam.position.copy(start);
  return { steps, checked, missing, stepsWithMissing: bad, worst, grown: (demo.info() as { grown?: number }).grown };
}
