// Touch controls for phones and tablets (GitHub issue #1): the left thumb is a movement stick that appears where it
// lands (push further = faster; holding still builds speed as the keys do), the right thumb drags to look, and
// buttons on the right hold up / down / 5x zoom. They drive FlyControls (src/controls.js) through its `analog` input
// and yaw/pitch, so speed ramp, zoom and the ground clamp are shared with the keyboard.
import * as THREE from 'three/webgpu';
import type { FlyControls } from './controls.ts';

const STICK_PX = 56; // stick travel radius (CSS pixels)
const LOOK = 0.0045; // radians per pixel dragged (divided by the zoom: finer aim through the zoom)

/** True on a device whose main pointer is a finger (or `?touch=1`; `?touch=0` turns the controls off). */
export function isTouchDevice(params: URLSearchParams): boolean {
  if (params.has('touch')) return params.get('touch') === '1';
  return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches;
}

export class TouchControls {
  readonly controls: FlyControls;
  stick: { id: number; x0: number; y0: number } | null = null;
  look: { id: number; x: number; y: number } | null = null;
  vertical = 0; // held up / down buttons
  stickX = 0;
  stickY = 0;
  readonly base: HTMLElement;
  readonly knob: HTMLElement;

  constructor(controls: FlyControls, dom: HTMLElement) {
    this.controls = controls;
    document.body.classList.add('touch');
    dom.style.touchAction = 'none';

    // the stick's base and knob (shown while the left thumb is down)
    this.base = el('div', 'touch-stick');
    this.knob = el('div', 'touch-knob');
    this.base.append(this.knob);
    document.body.append(this.base);

    dom.addEventListener('pointerdown', (e) => this._down(e));
    dom.addEventListener('pointermove', (e) => this._move(e));
    for (const t of ['pointerup', 'pointercancel'] as const) dom.addEventListener(t, (e) => this._up(e));

    // buttons: hold to climb / descend / zoom; fullscreen toggles
    const pad = el('div', 'touch-pad');
    const hold = (label: string, title: string, on: () => void, off: () => void): void => {
      const b = el('button', 'touch-btn', label);
      b.title = title;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        capture(b, e);
        b.classList.add('on');
        on();
      });
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, () => {
        if (!b.classList.contains('on')) return;
        b.classList.remove('on');
        off();
      });
      pad.append(b);
    };
    hold('▲', 'up', () => (this.vertical = 1), () => (this.vertical = Math.min(this.vertical, 0)));
    hold('▼', 'down', () => (this.vertical = -1), () => (this.vertical = Math.max(this.vertical, 0)));
    hold('5×', 'zoom', () => (controls.zoomTarget = controls.zoomMax), () => (controls.zoomTarget = 1));
    document.body.append(pad);
    if ('requestFullscreen' in document.documentElement) { // (iPhone Safari has none)
      const fs = el('button', 'touch-btn touch-fs', '⛶');
      fs.title = 'fullscreen';
      fs.addEventListener('click', () => controls.toggleFullscreen());
      document.body.append(fs);
    }
    // (no pinch zoom / double-tap zoom / pull-to-refresh on the page)
    document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('dblclick', (e) => e.preventDefault());
  }

  _down(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    capture(e.currentTarget as Element, e);
    document.getElementById('help-touch')?.classList.add('faded'); // (the hint has done its job)
    if (e.clientX < innerWidth / 2 && !this.stick) {
      this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.base.classList.add('on');
      this._setKnob(0, 0);
    } else if (!this.look) this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  _move(e: PointerEvent): void {
    const c = this.controls;
    if (this.stick?.id === e.pointerId) {
      let dx = e.clientX - this.stick.x0, dy = e.clientY - this.stick.y0;
      const len = Math.hypot(dx, dy);
      if (len > STICK_PX) (dx *= STICK_PX / len), (dy *= STICK_PX / len);
      this._setKnob(dx, dy);
    } else if (this.look?.id === e.pointerId) {
      const sens = LOOK / c.zoom;
      c.yaw -= (e.clientX - this.look.x) * sens;
      c.pitch = THREE.MathUtils.clamp(c.pitch - (e.clientY - this.look.y) * sens, -1.55, 1.55);
      this.look.x = e.clientX;
      this.look.y = e.clientY;
    }
  }

  _up(e: PointerEvent): void {
    if (this.stick?.id === e.pointerId) {
      this.stick = null;
      this.base.classList.remove('on');
      this._setKnob(0, 0);
    }
    if (this.look?.id === e.pointerId) this.look = null;
  }

  _setKnob(dx: number, dy: number): void {
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // a small dead zone, then a curve: fine control near the centre
    const shape = (v: number): number => {
      const m = Math.max(0, Math.abs(v) - 0.12) / 0.88;
      return Math.sign(v) * m * m;
    };
    this.stickX = shape(dx / STICK_PX);
    this.stickY = shape(dy / STICK_PX);
  }

  /** Per frame, before FlyControls.update(). */
  update(): void {
    this.controls.analog.set(this.stickX, this.vertical, -this.stickY);
  }
}

/** Keeps a finger's events coming to `target` when it slides off (fails for synthetic events: the harness probe). */
function capture(target: Element, e: PointerEvent): void {
  try {
    target.setPointerCapture(e.pointerId);
  } catch {
    /* not a live pointer */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}
