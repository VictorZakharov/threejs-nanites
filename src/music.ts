// Background music: the ambience track of ez-tree's demo app (public/audio/ambience.mp3, from ez-tree, MIT), looped:
// birdsong, so it fades out as you climb (full up to just over the canopy, gone a few hundred metres up: the user).
// Browsers only play sound after a gesture, so it starts on the first click, tap or key (as in ez-tree's app) and
// fades in; M, the menu's switch or the touch button mutes it, and the choice is remembered in this browser. Paused
// while the tab is hidden or it's out of earshot. Off under the harness unless ?music=1; ?music=0 starts muted.
const URL = 'audio/ambience.mp3'; // (relative: the site lives under the Pages subpath)
const STORE = 'nanite-forest.music';
const FADE_IN = 2.5, FADE_OUT = 0.4; // s (the track is quiet, -36 LUFS: full volume, as ez-tree plays it)
const HEARD = [40, 300]; // m above the ground: full up to the first (canopies ~25 m), silent from the second
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'] as const;

export interface Music {
  readonly audio: HTMLAudioElement;
  on: boolean;
  /** Fires when `on` changes (the touch button follows it). */
  onChange: (() => void) | null;
  /** The camera's height above the ground, every frame (m). */
  setAltitude(m: number): void;
}

const stored = (): string | null => {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
};
const store = (on: boolean): void => {
  try {
    localStorage.setItem(STORE, on ? '1' : '0');
  } catch {
    // (no storage: a private window; it just isn't remembered)
  }
};
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createMusic(params: URLSearchParams, harness: boolean): Music {
  const audio = new Audio(URL);
  audio.loop = true;
  audio.preload = 'none'; // (1 MB: fetched when it first plays, not with the scene)
  audio.volume = 0;
  const param = params.get('music');
  let on = harness ? param === '1' : param !== '0' && stored() !== '0';
  // (our own volume, the switch's fade times the height's: iOS ignores audio.volume, so nothing can wait for it)
  let level = 0, target = 0, height = 1, raf = 0;

  const sync = (): void => {
    const v = level * height;
    audio.volume = Math.min(1, v * v); // (perceived loudness goes roughly with the square)
    if (!audio.paused && ((target === 0 && level === 0) || height === 0)) audio.pause();
  };
  const fadeTo = (t: number, seconds: number): void => {
    target = t;
    cancelAnimationFrame(raf);
    let last = performance.now();
    const tick = (now: number): void => {
      const d = (now - last) / 1000 / seconds;
      last = now;
      level = target > level ? Math.min(target, level + d) : Math.max(target, level - d);
      sync();
      if (level !== target) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  const play = (): void => {
    if (!on || document.hidden || height === 0) return;
    audio.play().then(() => {
      for (const g of GESTURES) window.removeEventListener(g, play, true);
      // (muted or hidden since: M as the first key starts it here and mutes it in the menu's handler)
      fadeTo(on && !document.hidden ? 1 : 0, on ? FADE_IN : FADE_OUT);
    }, () => {}); // (no gesture yet: the next one tries again)
  };
  // (capture: the menu and the touch controls stop their events from reaching the page)
  for (const g of GESTURES) window.addEventListener(g, play, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return play();
    cancelAnimationFrame(raf); // (no frames in a hidden tab: no fade)
    level = target = 0;
    sync();
    audio.pause();
  });

  const music: Music = {
    audio,
    get on() {
      return on;
    },
    set on(v) {
      if (v === on) return;
      on = v;
      store(v);
      if (v) play();
      else fadeTo(0, FADE_OUT);
      music.onChange?.();
    },
    onChange: null,
    setAltitude(m) {
      const h = 1 - smoothstep(HEARD[0], HEARD[1], m);
      if (h === height) return;
      const was = height;
      height = h;
      sync();
      if (was === 0 && on) play(); // (back in earshot: it already had its gesture, or waits for one)
    },
  };
  return music;
}
