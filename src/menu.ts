// Settings menu (Esc; the gear on touch screens) and the keyboard shortcuts: both change the same switches, so they
// live together. Layout after gd-clone's pause menu (title, diamond rule, controls beside the settings), in the
// loading screen's colours. Esc while flying releases the mouse (the browser's own) and opens it; Resume or a click
// outside flies again.
import type { FlyControls } from './controls.ts';
import type { NaniteForest } from './nanite/forest.ts';
import type { TAA } from './taa.ts';
import type { GodRays } from './godrays.ts';
import type { AutoQuality } from './hud.ts';
import type { PerfPanel } from './perf-panel.ts';
import type { Music } from './music.ts';
import type { ProfileProgress } from './profile.ts';
import { createProfileBanner } from './profile-banner.ts';
import { reliefSteps, RELIEF_STEPS } from './ground/relief.ts';

export interface MenuContext {
  controls: FlyControls;
  forest: NaniteForest;
  taa: TAA;
  rays: GodRays;
  clouds: { visible: boolean };
  grass: { visible: boolean };
  auto: AutoQuality;
  perf: PerfPanel | null;
  music: Music;
  shadowsOn(): boolean;
  setShadows(on: boolean): void;
  setScale(s: number): void;
  profile(progress?: ProfileProgress): Promise<string>;
  touch: boolean;
}

/** A switch: its label, shortcut, state and how to flip it. */
interface Toggle {
  label: string;
  key?: string; // KeyboardEvent.code
  get(): boolean;
  set(v: boolean): void;
}

const PRESETS = { auto: null, high: [1, 1], medium: [3, 0.75], low: [8, 0.5] } as const; // tau, resolution scale
type Preset = keyof typeof PRESETS;
const DEBUG = ['off', 'cluster', 'level', 'tree', 'type', 'raster'];

const CONTROLS: [string, string][] = [
  ['WASD', 'walk / fly'], ['Space', 'jump, twice: fly'], ['Space / Ctrl', 'up / down (land: walk)'], ['Shift', 'fast'], ['Mouse', 'look'], ['Right mouse', 'zoom 5×'],
  ['F', 'freeze culling'], ['[ ]', 'error threshold'], ['Q', 'auto quality'], ['L', 'debug colours'],
  ['H', 'help'], ['F11', 'fullscreen'], ['Esc', 'this menu'],
];
const TOUCH_CONTROLS: [string, string][] = [
  ['Left thumb', 'move'], ['Right thumb', 'look'], ['▲', 'jump, twice: fly'], ['▼', 'down (land: walk)'], ['5×', 'zoom'], ['⚙', 'this menu'],
];

export function createMenu(ctx: MenuContext) {
  const { controls, forest, taa, rays, auto, perf, music } = ctx;
  const u = forest.u;
  const byId = (id: string) => document.getElementById(id);
  const shown = (id: string) => () => !byId(id)?.classList.contains('hidden');
  const show = (id: string) => (v: boolean) => byId(id)?.classList.toggle('hidden', !v);

  const scene: Toggle[] = [
    { label: 'Shadows', key: 'KeyP', get: ctx.shadowsOn, set: ctx.setShadows },
    { label: 'Anti-aliasing (TAA)', key: 'KeyT', get: () => taa.enabled, set: (v) => ((taa.enabled = v), (taa.reset = true)) },
    { label: 'God rays', key: 'KeyR', get: () => rays.enabled, set: (v) => (rays.enabled = v) },
    { label: 'Wind', key: 'KeyG', get: () => u.wind.value > 0, set: (v) => (u.wind.value = v ? 1 : 0) },
    { label: 'Grass', get: () => ctx.grass.visible, set: (v) => (ctx.grass.visible = v) },
    { label: 'Ground relief', get: () => reliefSteps.value > 0, set: (v) => (reliefSteps.value = v ? RELIEF_STEPS : 0) },
    { label: 'Clouds', get: () => ctx.clouds.visible, set: (v) => (ctx.clouds.visible = v) },
    { label: 'Music', key: 'KeyM', get: () => music.on, set: (v) => (music.on = v) },
    { label: 'Occlusion culling', get: () => forest.occlusionOn, set: (v) => (forest.occlusionOn = v) },
    ...(u.sw ? [{ label: 'Software rasterizer', get: () => u.sw!.value > 0, set: (v: boolean) => (u.sw!.value = v ? 1 : 0) }] : []),
  ];
  const overlays: Toggle[] = [
    { label: 'Waypoint to the statues', get: shown('waypoint'), set: show('waypoint') },
    { label: 'Compass (walking)', get: shown('compass'), set: show('compass') },
    ...(perf ? [{ label: 'Performance panel', get: shown('corner'), set: show('corner') }] : []),
    ...(ctx.touch ? [] : [{ label: 'Scene details', get: shown('hud'), set: show('hud') }]),
    ...(ctx.touch ? [] : [{ label: 'Help', key: 'KeyH', get: shown('help'), set: show('help') }]),
  ];

  // ---- markup
  const el = document.createElement('div');
  el.id = 'menu';
  el.className = 'hidden';
  const row = (t: Toggle, i: number, group: string) =>
    `<label class="opt"><input type="checkbox" data-t="${group}${i}"><span>${t.label}</span>${t.key ? `<kbd>${t.key.replace('Key', '')}</kbd>` : ''}</label>`;
  el.innerHTML = `
    <div class="menu-box" role="dialog" aria-label="Settings">
      <h2>SETTINGS</h2>
      <div class="menu-rule">◆</div>
      <div class="menu-cols">
        <section>
          <h3>Quality</h3>
          <div class="seg" data-seg="quality">${Object.keys(PRESETS).map((p) => `<button data-v="${p}">${p}</button>`).join('')}</div>
          <h3>Scene</h3>
          ${scene.map((t, i) => row(t, i, 's')).join('')}
          <h3>Debug colours</h3>
          <div class="seg" data-seg="debug">${DEBUG.map((d, i) => `<button data-v="${i}">${d}</button>`).join('')}</div>
        </section>
        <section>
          ${overlays.length ? `<h3>Overlays</h3>${overlays.map((t, i) => row(t, i, 'o')).join('')}` : ''}
          <h3>Performance</h3>
          <button class="menu-btn" data-a="profile">Profile GPU<small>up to a minute: don't move the view</small></button>
          <button class="menu-btn" data-a="copy">Copy performance report</button>
          <h3>Controls</h3>
          <dl>${(ctx.touch ? TOUCH_CONTROLS : CONTROLS).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        </section>
      </div>
      <div class="menu-actions">
        <button class="menu-btn" data-a="fullscreen">Fullscreen</button>
        <button class="menu-btn primary" data-a="resume">Resume</button>
      </div>
    </div>`;
  document.body.append(el);
  const q = <T extends Element>(s: string) => [...el.querySelectorAll<T>(s)];
  const toggleOf = (id: string): Toggle => (id[0] === 's' ? scene : overlays)[Number(id.slice(1))];

  const preset = (): Preset => {
    if (auto.on) return 'auto';
    const hit = (Object.keys(PRESETS) as Preset[]).find((p) => PRESETS[p]?.[0] === u.tau.value && PRESETS[p]?.[1] === auto.scale);
    return hit ?? ('' as Preset);
  };
  function refresh(): void {
    for (const c of q<HTMLInputElement>('input[data-t]')) c.checked = toggleOf(c.dataset.t!).get();
    const seg = (name: string, v: string) => q<HTMLButtonElement>(`[data-seg="${name}"] button`).forEach((b) => b.classList.toggle('active', b.dataset.v === v));
    seg('quality', preset());
    seg('debug', String(u.debug.value));
  }

  // ---- behaviour
  el.addEventListener('pointerdown', (e) => e.stopPropagation()); // (not a look drag on the canvas below)
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === el) return resume(); // (outside the box)
    const t = e.target as HTMLElement;
    const input = t.closest<HTMLInputElement>('input[data-t]');
    if (input) toggleOf(input.dataset.t!).set(input.checked);
    const segBtn = t.closest<HTMLButtonElement>('[data-seg] button');
    if (segBtn) {
      const v = segBtn.dataset.v!, seg = segBtn.parentElement!.dataset.seg;
      if (seg === 'debug') u.debug.value = Number(v);
      else {
        const p = PRESETS[v as Preset];
        auto.on = !p;
        if (p) {
          u.tau.value = p[0];
          ctx.setScale(p[1]);
        }
      }
    }
    const action = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (action === 'resume') resume();
    if (action === 'fullscreen') controls.toggleFullscreen();
    if (action === 'copy') perf?.copy();
    if (action === 'profile' && performance.now() - profileAt > 1000) runProfile(); // (a key's click: see pointerup)
    refresh();
  });

  // Profile GPU starts when the press ends, however long it was: on a phone a long press fires no click, and the
  // button's "hold still" read as press and hold (the user); a finger that scrolls the menu cancels instead
  let profileAt = 0;
  const onProfile = (e: Event): boolean => Boolean((e.target as HTMLElement).closest('[data-a="profile"]'));
  el.addEventListener('pointerup', (e) => {
    if (!onProfile(e)) return;
    profileAt = performance.now();
    runProfile();
  });
  el.addEventListener('contextmenu', (e) => onProfile(e) && e.preventDefault());

  // the button says what it will do (the browser's own F11 fullscreen isn't the page's: it says "Fullscreen" there)
  const fsBtn = q<HTMLButtonElement>('[data-a="fullscreen"]')[0];
  const syncFullscreen = () => (fsBtn.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
  document.addEventListener('fullscreenchange', syncFullscreen);
  fsBtn.classList.toggle('hidden', !document.fullscreenEnabled);

  const banner = createProfileBanner(); // (the profile's progress, on screen)
  let open = false;
  function setOpen(v: boolean): void {
    open = v;
    el.classList.toggle('hidden', !v);
    document.body.classList.toggle('menu-open', v);
    if (v) refresh();
  }
  function resume(): void {
    setOpen(false);
    if (!ctx.touch) controls.capture();
  }
  async function runProfile(): Promise<void> {
    setOpen(false); // (the menu's blur would be measured too)
    if (!perf) return;
    perf.status("PROFILING: DON'T MOVE");
    try {
      perf.profileText = await ctx.profile((label, i, n, left) => banner.progress(label, i, n, left));
      perf.status('PROFILED: TAP TO COPY THE REPORT');
      banner.done(() => perf.copy());
    } catch (err) {
      banner.failed();
      perf.status('PROFILE FAILED');
      console.warn(err);
    }
  }

  // Esc while flying: the browser releases the mouse (no key event), so losing the lock opens the menu
  let unlockedAt = 0;
  controls.onUnlock = () => {
    unlockedAt = performance.now();
    setOpen(true);
  };
  if (ctx.touch) {
    const gear = document.createElement('button');
    gear.className = 'touch-btn touch-menu';
    gear.textContent = '⚙';
    gear.title = 'settings';
    gear.addEventListener('pointerdown', (e) => e.stopPropagation());
    gear.addEventListener('click', () => setOpen(!open));
    // (no keyboard: the music's switch on screen too, beside the gear)
    const note = document.createElement('button');
    note.className = 'touch-btn touch-music';
    note.textContent = '♪';
    note.title = 'music';
    const sync = () => note.classList.toggle('muted', !music.on);
    note.addEventListener('pointerdown', (e) => e.stopPropagation());
    note.addEventListener('click', () => (music.on = !music.on));
    music.onChange = () => (sync(), open && refresh());
    sync();
    document.body.append(gear, note);
  }

  // keyboard shortcuts (the same switches)
  controls.onKey = (code) => {
    if (code === 'Escape') {
      // (outside fullscreen the browser may release the mouse, which already opened the menu, before this key)
      if (performance.now() - unlockedAt < 300) return;
      if (open) return resume();
      setOpen(true);
      return controls.release();
    }
    for (const t of [...scene, ...overlays]) if (t.key === code) t.set(!t.get());
    if (code === 'KeyL') u.debug.value = (u.debug.value + 1) % DEBUG.length;
    if (code === 'KeyF') forest.frozen = !forest.frozen;
    if (code === 'BracketLeft' || code === 'Minus') (auto.on = false), (u.tau.value = Math.max(0.25, u.tau.value / 1.5));
    if (code === 'BracketRight' || code === 'Equal') (auto.on = false), (u.tau.value = Math.min(64, u.tau.value * 1.5));
    if (code === 'KeyQ') auto.on = !auto.on;
    if (open) refresh();
  };

  return { setOpen, get open() { return open; } };
}
