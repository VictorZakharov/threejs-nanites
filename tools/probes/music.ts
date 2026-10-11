// Background music (src/music.ts; --query=music=1, else it starts muted and this checks it stays silent): nothing is
// fetched before a gesture, a click starts it (fading in), M mutes it (fading out, then paused) and M again plays on.
// The harness's browser allows autoplay, so a synthetic event stands in for the gesture.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const { audio } = demo.music;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fetched = () => performance.getEntriesByType('resource').some((e) => e.name.includes('ambience'));
  const state = () => ({ on: demo.music.on, paused: audio.paused, time: +audio.currentTime.toFixed(2), volume: +audio.volume.toFixed(2), fetched: fetched() });
  const key = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code }));
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
  r.help = document.getElementById('help')?.textContent?.includes('music');
  return r;
}
