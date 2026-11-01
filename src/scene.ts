// Which scene the page shows, chosen on the loading screen: the forest, or the Lucy forest (250k statues of
// Stanford's Lucy, 4M triangles each at full detail: 1T triangles through the cluster LOD). Two buttons and a
// countdown; with no choice in COUNTDOWN ms, the forest. `?scene=forest|lucy` skips it, as does the harness (forest;
// `?choose=1` shows it there too). Only the planting and Lucy's download (her file) wait for the choice: the textures,
// trees and terrain start meanwhile (src/main.ts).

export type SceneName = 'forest' | 'lucy';
export const SCENE_TITLES: Record<SceneName, string> = { forest: 'Forest', lucy: 'Lucy forest' };

/** How long the choice waits before the forest (ms). */
const COUNTDOWN = 5000;
/** The countdown holds while the pointer moves over a button, and goes on this long after it stops (ms). */
const HOLD = 3000;

/** The scene `?scene=` names, if any. */
export function sceneOf(params: URLSearchParams): SceneName | null {
  const s = params.get('scene');
  return s === 'forest' || s === 'lucy' ? s : null;
}

export interface SceneChoice {
  /** The scene, once chosen (or the countdown ran out). */
  scene: Promise<SceneName>;
  /** How it was chosen, for the log: 'url', 'harness', 'clicked', 'countdown' or 'cancelled'. */
  how: () => string;
  /** Ends the choice with the forest (the WebGL mode has only the forest). */
  cancel: () => void;
}

/** Shows the choice on the loading screen unless the URL or the harness settles it. */
export function chooseScene(params: URLSearchParams, harness: boolean): SceneChoice {
  const fixed = sceneOf(params);
  if (fixed || (harness && params.get('choose') !== '1')) {
    const how = fixed ? 'url' : 'harness';
    return { scene: Promise.resolve(fixed ?? 'forest'), how: () => how, cancel: () => {} };
  }
  const root = document.querySelector<HTMLElement>('[data-scene-choice]');
  if (!root) throw new Error('Loading screen markup is missing [data-scene-choice].');
  const count = root.querySelector<HTMLElement>('[data-scene-countdown]')!;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[data-scene]')];
  let how = 'countdown', done: (s: SceneName) => void = () => {};
  const scene = new Promise<SceneName>((r) => (done = r));
  // (the user, choosing: "moving a mouse over either option... stop the timer, resume after 3 s of not moving")
  let end = performance.now() + COUNTDOWN, heldAt = 0, lastMove = 0;
  const bar = root.querySelector<HTMLElement>('button i');
  const left = (now: number): number => (heldAt ? end - heldAt : end - now);
  const tick = (now: number): void =>
    void (count.textContent = `${SCENE_TITLES.forest} in ${Math.max(0, Math.ceil(left(now) / 1000))} s${heldAt ? ' · paused' : ''}`);
  const timer = setInterval(() => {
    const now = performance.now();
    if (heldAt && now - lastMove >= HOLD) {
      end += now - heldAt; // (resumed: the time held is added on)
      heldAt = 0;
      if (bar) bar.style.animationPlayState = 'running';
    }
    if (!heldAt && now >= end) finish('forest');
    else tick(now);
  }, 100);
  const onMove = (): void => {
    lastMove = performance.now();
    if (heldAt) return;
    heldAt = lastMove;
    if (bar) bar.style.animationPlayState = 'paused';
    tick(lastMove);
  };
  const onKey = (e: KeyboardEvent): void => {
    const pick = e.key === '1' || e.key === 'Enter' ? 'forest' : e.key === '2' ? 'lucy' : null;
    if (pick) (how = 'clicked'), finish(pick);
  };
  function finish(s: SceneName): void {
    clearInterval(timer);
    window.removeEventListener('keydown', onKey);
    for (const b of buttons) b.removeEventListener('pointermove', onMove);
    root!.hidden = true;
    done(s);
  }
  for (const b of buttons) b.addEventListener('pointermove', onMove);
  for (const b of buttons) b.addEventListener('click', () => ((how = 'clicked'), finish(b.dataset.scene === 'lucy' ? 'lucy' : 'forest')), { once: true });
  window.addEventListener('keydown', onKey);
  root.hidden = false;
  root.style.setProperty('--countdown', `${COUNTDOWN}ms`);
  tick(performance.now());
  return { scene, how: () => how, cancel: () => void (!root.hidden && ((how = 'cancelled'), finish('forest'))) };
}
