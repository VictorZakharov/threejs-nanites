// Background music (src/music.ts; --query=music=1, else it starts muted and this checks it stays silent): nothing is
// fetched before a gesture, a click starts it on the ground (fading in), M mutes it (fading out, then paused) and M
// again plays on; it's quieter 150 m up and paused 400 m up (birdsong: out of earshot), and plays again back down.
// The harness's browser allows autoplay, so a synthetic event stands in for the gesture.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const { audio } = demo.music;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fetched = () => performance.getEntriesByType('resource').some((e) => e.name.includes('ambience'));
  const state = () => ({ on: demo.music.on, paused: audio.paused, time: +audio.currentTime.toFixed(2), volume: +audio.volume.toFixed(2), fetched: fetched() });
  const key = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  const at = async (agl: number) => {
    demo.setView({ x: 0, z: -40, agl, yaw: 0, pitch: -10 });
    await demo.renderOnce();
  };
  await at(2);
  const r: Record<string, unknown> = { before: state() };
  window.dispatchEvent(new PointerEvent('pointerdown'));
  await wait(3000);
  r.clicked = state();
  key('KeyM');
  await wait(1000);
  r.muted = state();
  key('KeyM');
  await wait(1500);
  r.unmuted = state();
  await wait(1200);
  await at(150);
  r.at150m = state();
  await at(400);
  await wait(200);
  r.at400m = state();
  await at(2);
  await wait(500);
  r.down = state();
  r.help = document.getElementById('help')?.textContent?.includes('music');
  return r;
}
