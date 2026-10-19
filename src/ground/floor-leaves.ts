// The fallen leaves, one layer per kind of tree (oak, ash, aspen, conifer), each a tileable map of that kind's leaves
// in three or four layers: the floor (floor.ts) lays the layer of the tree above over the soil. Per texel: red the
// height (cm / HEIGHT_CM, 0 = no leaf), green / blue the normal (as buildPBR's), alpha the leaf's key: it lies there
// if the amount fallen is over (key - 0.1) / 0.9 (the upper layers go first as the amount drops). The colour is the
// shader's (by the key: older below, and by the tree's autumn level). Conifer litter is sprays after the user's
// photo (a stem with short needles off both sides, rust brown, thick), at twice the resolution: 2.5 m a tile.
import { makeScatter, clamp, HEIGHT_CM, FLOOR_TILE } from './floor-maps.ts';

export const LEAF_KINDS = ['oak', 'ash', 'aspen', 'pine'] as const;
export type LeafKind = (typeof LEAF_KINDS)[number];
/** A layer's tile (m): the conifer sprays are finer. */
export const LEAF_TILE: Record<LeafKind, number> = { oak: FLOOR_TILE, ash: FLOOR_TILE, aspen: FLOOR_TILE, pine: FLOOR_TILE / 2 };

interface Kind {
  cells: number; // scatter grid per tile
  shares: number[]; // per layer, bottom up: share of cells with a leaf
  half: [number, number]; // half length (cm), min..max
  /** Whether (along -1..1, across in cm from the axis) is on the leaf, given its half length; its relief (cm) there. */
  shape(along: number, w: number, half: number, id: number): number | null;
}

const leafBlade = (wide: number, profile: (t: number) => number) => (t: number, w: number, half: number, id: number): number | null => {
  const width = half * wide * (0.85 + id * 0.3) * profile(t);
  if (width <= 0) return null;
  const across = w / width;
  if (Math.abs(across) >= 1) return null;
  const rib = Math.max(0, 1 - Math.abs(w) / 0.25);
  const vein = Math.max(0, 1 - Math.abs(((t * 3.5 - Math.abs(across) * 1.4) % 1 + 1) % 1 - 0.5) / 0.08);
  return across * across * 0.45 + rib * 0.12 - vein * 0.04; // (cupped, raised midrib, veins pressed in)
};
const tipTaper = (t: number): number => Math.pow(Math.sin((t + 1) * Math.PI / 2), 0.85) * (t < 0 ? 1 : 1 - t * 0.25);

const KINDS: Record<LeafKind, Kind> = {
  // oak: long, with round lobes down both sides
  oak: { cells: 56, shares: [0.6, 0.5, 0.4], half: [4.5, 6.5], shape: leafBlade(0.42, (t) => tipTaper(t) * (0.62 + 0.38 * Math.abs(Math.cos(t * Math.PI * 2.6)))) },
  // ash: small narrow leaflets, pointed at both ends
  ash: { cells: 80, shares: [0.6, 0.5, 0.4], half: [2.6, 4], shape: leafBlade(0.3, (t) => Math.pow(Math.sin((t + 1) * Math.PI / 2), 1.1)) },
  // aspen: round, heart-shaped at the stalk, a short point at the tip
  aspen: { cells: 72, shares: [0.6, 0.5, 0.4], half: [2.4, 3.6], shape: leafBlade(0.88, (t) => Math.sqrt(Math.max(0, 1 - t * t)) * (1 - Math.max(0, t - 0.45) * 0.9) * (t < -0.75 ? 0.75 + (t + 1) : 1)) },
  // conifer sprays: a stem with short needles off both sides, leaning forward, shorter to the tip (cm, 2.5 m tile)
  pine: {
    cells: 40, shares: [0.9, 0.85, 0.8, 0.75], half: [3.5, 6],
    shape(t, w, half) {
      const a = (t + 1) * half, len = half * 2; // cm from the base
      if (Math.abs(w) < 0.16) return 0.25; // the stem
      const sn = 0.62, cs = 0.78, gap = 0.55; // needles 38 degrees off the stem, every 0.55 cm a side
      const a0 = a - Math.abs(w) * (cs / sn); // where the needle through this point leaves the stem
      if (a0 < 0) return null;
      const k = Math.round(a0 / gap), base = k * gap;
      const perp = Math.abs(a0 - base) * sn;
      const reach = Math.abs(w) / sn, nl = 1.5 * Math.sqrt(Math.max(0, 1 - base / len)) * (0.8 + ((k * 0.618) % 1) * 0.4);
      if (perp > 0.13 || reach > nl) return null;
      return 0.15 - reach * 0.05;
    },
  },
};

/** One kind's layer: RGBA texels, `size` square (floor-worker.ts: a worker each). */
export function leafLayer(kind: LeafKind, size: number, seed: number): Uint8ClampedArray<ArrayBuffer> {
  const K = KINDS[kind], n = size * size, tileCm = LEAF_TILE[kind] * 100, cm = tileCm / size;
  const layers = K.shares.map((sh, li) => makeScatter(seed + li * 2, K.cells, sh));
  const height = new Float32Array(n), key = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let h = 0, kk = 0;
      layers.forEach((layer, li) => {
        const near = layer.near(u, v), cell = tileCm / layer.cells;
        for (let j = 0; j < near.count; j++) {
          const id = near.k[j], z = layer.size[id], half = K.half[0] + z * (K.half[1] - K.half[0]);
          const px = -near.dx[j] * cell, py = -near.dy[j] * cell;
          if (px * px + py * py >= half * half) continue;
          const cs = layer.cos[id], sn = layer.sin[id];
          const a = px * cs + py * sn, w0 = -px * sn + py * cs;
          const t = a / half;
          if (Math.abs(t) >= 1) continue;
          const relief = K.shape(t, w0, half, layer.id[id]);
          if (relief === null) continue;
          const top = 0.6 + li * 0.4 + z * 0.15 + relief;
          if (top <= h) continue;
          h = top;
          const r = ((Math.imul(id + li * 7919 + seed, 2654435761) >>> 0) / 4294967296);
          kk = 0.1 + 0.9 * clamp(li / K.shares.length + r / K.shares.length, 0, 0.999);
        }
      });
      height[y * size + x] = h;
      key[y * size + x] = kk;
    }
  }
  // normals from the heights (a leaf's edge falls off a little: its neighbours without a leaf count 0.3 cm lower)
  const out = new Uint8ClampedArray(n * 4), strength = 1 / (2 * cm);
  const at = (x: number, y: number, own: number) => {
    const hh = height[((y + size) % size) * size + ((x + size) % size)];
    return hh > 0 ? hh : own - 0.3;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x, h = height[i];
      if (h <= 0) continue;
      const dx = (at(x + 1, y, h) - at(x - 1, y, h)) * strength, dy = (at(x, y + 1, h) - at(x, y - 1, h)) * strength;
      const len = Math.hypot(dx, dy, 1);
      out[i * 4] = Math.max(1, clamp(h / HEIGHT_CM, 0, 1) * 255);
      out[i * 4 + 1] = (-dx / len * 0.5 + 0.5) * 255;
      out[i * 4 + 2] = (dy / len * 0.5 + 0.5) * 255;
      out[i * 4 + 3] = key[i] * 255;
    }
  }
  return out;
}

/** All kinds' layers, one after the other (LEAF_KINDS order): a texture array's data. */
