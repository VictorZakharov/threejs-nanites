// How much of the view a group of leaf cards covers (leaves.ts): their opaque area, through the leaf texture's
// alpha, projected along a few directions and counted on a grid (overlaps once). A coarser leaf level keeps half
// the cards and grows them until they cover what the whole group did. Growing them by sqrt(2) (keeping their total
// area) covered much more: a crown's leaves overlap a lot, the fewer, bigger cards much less, so each level closed
// the gaps between the crowns and the forest turned into a bright even carpet as the detail dropped (the user's
// zoom at tau 8: "washed").
import type { LeafMask } from './types.ts';

// the directions it's seen from: from above, from the side (two ways: cards stand at all angles), and a diagonal
// (five directions and finer cells chose the same growth within ~0.03, in twice the time)
const DIRS: number[][] = [[0, 1, 0], [1, 0, 0], [0, 0, 1], [0.577, 0.577, 0.577]];
const BASES = DIRS.map((d) => {
  const h = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = [h[1] * d[2] - h[2] * d[1], h[2] * d[0] - h[0] * d[2], h[0] * d[1] - h[1] * d[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  const uu = u.map((x) => x / ul);
  return [uu, [d[1] * uu[2] - d[2] * uu[1], d[2] * uu[0] - d[0] * uu[2], d[0] * uu[1] - d[1] * uu[0]]];
});
const MAX_GRID = 320;
const CELLS_PER_CARD = 5; // (along a card's side: 25 cells; the mask's shape matters, not each texel)

/** A card to count: its first vertex in `pos` and its centre (it grows round it). */
export interface Card {
  first: number;
  ctr: number[];
}

/** Counts the projected opaque area of sets of cards on a grid fitted round them (one grid for a whole group). */
export class Coverage {
  readonly pos: ArrayLike<number>;
  readonly uv: ArrayLike<number>;
  readonly vpl: number;
  readonly mask: LeafMask;
  readonly cells = new Uint32Array(MAX_GRID * MAX_GRID);
  stamp = 0;
  // the grid (per direction: its origin), set by fit()
  g = 1;
  cell = 1;
  origin: number[][] = [];

  constructor(pos: ArrayLike<number>, uv: ArrayLike<number>, vpl: number, mask: LeafMask) {
    this.pos = pos;
    this.uv = uv;
    this.vpl = vpl;
    this.mask = mask;
  }

  /** Fits the grid round `cards` grown up to `maxScale`; `cardSize`: their typical side (m). */
  fit(cards: Card[], maxScale: number, cardSize: number): void {
    const P = this.pos;
    let reach = 0; // (each card's farthest corner from its centre, grown)
    const c = [0, 0, 0];
    for (const k of cards) for (let a = 0; a < 3; a++) c[a] += k.ctr[a] / cards.length;
    let r = 0;
    for (const k of cards) {
      r = Math.max(r, Math.hypot(k.ctr[0] - c[0], k.ctr[1] - c[1], k.ctr[2] - c[2]));
      for (let v = 0; v < this.vpl; v++) {
        const i = (k.first + v) * 3;
        reach = Math.max(reach, Math.hypot(P[i] - k.ctr[0], P[i + 1] - k.ctr[1], P[i + 2] - k.ctr[2]));
      }
    }
    const half = r + reach * maxScale;
    this.cell = Math.max((2 * half) / MAX_GRID, cardSize / CELLS_PER_CARD);
    this.g = Math.min(MAX_GRID, Math.ceil((2 * half) / this.cell));
    this.origin = BASES.map(([u, v]) => [c[0] * u[0] + c[1] * u[1] + c[2] * u[2] - half, c[0] * v[0] + c[1] * v[1] + c[2] * v[2] - half]);
  }

  /** The cards' opaque area seen from every direction (cells, summed), each grown by `scale` round its centre. */
  count(cards: Card[], scale: number): number {
    let total = 0;
    for (let d = 0; d < BASES.length; d++) {
      const stamp = ++this.stamp;
      for (const k of cards) for (let q = 0; q < this.vpl; q += 4) total += this._quad(k, q, scale, d, stamp);
    }
    return total;
  }

  /** Rasterizes one quad of a card (vertices first+q .. +3: top-left, bottom-left, bottom-right, top-right). */
  _quad(k: Card, q: number, scale: number, d: number, stamp: number): number {
    const P = this.pos, UV = this.uv, [u, v] = BASES[d], [ox, oy] = this.origin[d], cell = this.cell, g = this.g;
    const at = (n: number): [number, number] => {
      const i = (k.first + q + n) * 3;
      const x = k.ctr[0] + (P[i] - k.ctr[0]) * scale, y = k.ctr[1] + (P[i + 1] - k.ctr[1]) * scale, z = k.ctr[2] + (P[i + 2] - k.ctr[2]) * scale;
      return [(x * u[0] + y * u[1] + z * u[2] - ox) / cell, (x * v[0] + y * v[1] + z * v[2] - oy) / cell];
    };
    // p = v1 + s (v2 - v1) + t (v0 - v1), and the same in uv
    const p0 = at(0), p1 = at(1), p2 = at(2);
    const ax = p2[0] - p1[0], ay = p2[1] - p1[1], bx = p0[0] - p1[0], by = p0[1] - p1[1];
    const det = ax * by - ay * bx;
    if (Math.abs(det) < 1e-3) return 0; // (edge-on)
    const t1 = (k.first + q + 1) * 2, t2 = (k.first + q + 2) * 2, t0 = (k.first + q) * 2;
    const u1 = UV[t1], w1 = UV[t1 + 1], dus = UV[t2] - u1, dws = UV[t2 + 1] - w1, dut = UV[t0] - u1, dwt = UV[t0 + 1] - w1;
    const xs = [p1[0], p1[0] + ax, p1[0] + bx, p1[0] + ax + bx], ys = [p1[1], p1[1] + ay, p1[1] + by, p1[1] + ay + by];
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(g - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(g - 1, Math.ceil(Math.max(...ys)));
    const n = this.mask.size, bits = this.mask.bits, cells = this.cells;
    let added = 0;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - p1[1];
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - p1[0];
        const s = (dx * by - dy * bx) / det, t = (ax * dy - ay * dx) / det;
        if (s < 0 || s >= 1 || t < 0 || t >= 1) continue;
        const tu = u1 + s * dus + t * dut, tv = w1 + s * dws + t * dwt;
        // (rows from the image's top: the leaf shader samples v = 0 there, see textures.ts)
        const mx = Math.min(n - 1, Math.max(0, Math.floor((tu - Math.floor(tu)) * n)));
        const my = Math.min(n - 1, Math.max(0, Math.floor((tv - Math.floor(tv)) * n)));
        if (!bits[my * n + mx]) continue;
        const c = y * g + x;
        if (cells[c] !== stamp) {
          cells[c] = stamp;
          added++;
        }
      }
    }
    return added;
  }
}
