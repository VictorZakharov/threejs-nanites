// Keeps a view's fixed-size lists from filling. What's past a list's cap is dropped in whichever order the threads got
// there, by runs of adjacent instances and differently each frame: whole groups of neighbours flicker (the user, with [
// pressed a few times zoomed in over the Lucy forest: "flickering like crazy"), and only coarser detail can make room.
// The counters are read back a few times a second: near a cap the view's tau goes up by a factor (View.tauMul, no new
// shader), well under it the factor eases back to 1. Clusters go by about 1 / tau^2 (Lucy `oblique`, zoomed: 771k at tau
// 5, 293k at 8), so x1.15 takes 0.9 full to ~0.68 and /1.1 takes 0.45 to ~0.54: it settles in between, not swinging. A
// clamped count doesn't say by how much it's over: x1.5, until it reads under the cap.
import type * as THREE from 'three/webgpu';
import { ARGS, ITEM_COUNT, LIST_CAP, MAX_ITEMS, RETEST, RETEST_CAP, SW, SW_CAP } from './constants.ts';
import type { View } from './types.ts';

const ON = new URLSearchParams(location.search).get('listguard') !== '0';
const EVERY_MS = 150, HIGH = 0.9, LOW = 0.45, UP = 1.15, UP_FULL = 1.5, DOWN = 1.1;

/** A view's guard: `scale` multiplies its tau. */
export class ListGuard {
  scale = 1;
  private busy = false;
  private last = 0;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly view: View;

  constructor(renderer: THREE.WebGPURenderer, view: View) {
    this.renderer = renderer;
    this.view = view;
  }

  /** Call at the start of a frame, before the culling: the counters hold the last whole frame. */
  update(): void {
    const now = performance.now();
    if (!ON || this.busy || now - this.last < EVERY_MS || !this.view.ran) return;
    this.busy = true;
    this.last = now;
    this.renderer.getArrayBufferAsync(this.view.ctr.attr).then((buf) => {
      this.busy = false;
      const fill = this.fill(new Uint32Array(buf));
      if (fill >= 1) this.scale *= UP_FULL;
      else if (fill >= HIGH) this.scale *= UP;
      else if (fill < LOW) this.scale = Math.max(1, this.scale / DOWN);
    }, () => {
      this.busy = false;
    });
  }

  /** How full the fullest list was (1: at its cap, so some may have been dropped). */
  private fill(ctr: Uint32Array): number {
    let fill = 0;
    this.view.sets.forEach((set, k) => {
      if (k > 0 && !set.ran) return;
      const b = set.base;
      fill = Math.max(fill, ctr[b + ARGS.bark + 1] / LIST_CAP, ctr[b + ARGS.leaf + 1] / LIST_CAP, ctr[b + ITEM_COUNT] / MAX_ITEMS);
    });
    return this.view.retest ? Math.max(fill, ctr[RETEST + 1] / RETEST_CAP, ctr[SW] / SW_CAP) : fill;
  }
}
