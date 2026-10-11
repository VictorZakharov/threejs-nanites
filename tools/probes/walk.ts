// Walking (src/controls.ts; needs --query=walk=1, the harness otherwise only flies): drives the controls directly at
// 60 Hz with synthetic keys and checks each step: standing on the ground at eye height, walking forward, a jump, a
// double jump into flight, then flying down until it lands walking again.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const c = demo.controls, p = demo.camera.position, dt = 1 / 60;
  const run = (s: number, keys: string[] = []): void => {
    keys.forEach((k) => c.keys.add(k));
    for (let i = 0; i < Math.round(s / dt); i++) c.update(dt);
    keys.forEach((k) => c.keys.delete(k));
  };
  const tap = (k: string): void => { c.keys.add(k); c.update(dt); c.keys.delete(k); c.update(dt); };
  const ground = c.groundAt;
  const eye = (): number => +(p.y - (ground ? ground(p.x, p.z) : 0)).toFixed(2);
  if (!c.walkEnabled) return { error: 'walking is off (use --query=walk=1)' };
  c.walking = true;
  run(0.5);
  const r: Record<string, unknown> = { standing: { walking: c.walking, eye: eye() } };
  const x0 = p.x, z0 = p.z;
  run(1, ['KeyW']);
  r.walked = { metres: +Math.hypot(p.x - x0, p.z - z0).toFixed(2), eye: eye() };
  tap('Space');
  run(0.15);
  r.jump = { walking: c.walking, eye: eye() };
  tap('Space');
  r.doubleJump = { walking: c.walking };
  run(1, ['Space']);
  r.flewUp = { walking: c.walking, eye: eye() };
  run(6, ['ControlLeft']);
  run(0.5);
  r.landed = { walking: c.walking, eye: eye() };
  return r;
}
