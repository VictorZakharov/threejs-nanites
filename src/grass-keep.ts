// The grass's keep test, in compute: one thread per cell of each ring's tiles in view decides whether its blade is
// drawn (density from the canopy cover, the slope and patch noise, tufts, the rings' cross-fade and morph, behind the
// camera) and appends the kept ones with what the vertex shader needs (root, height, width, lean, bend, colour) to the
// ring's list; the ring is one indirect draw of that many blades. It was all in the vertex shader, with every cell's
// blade drawn and the dropped ones collapsed onto their root: the vertex invocations cost, kept or not (x4 the blades
// +0.3-0.5 ms on the dev GPU, the same on the forest floor where nearly every blade is dropped).
import * as THREE from 'three/webgpu';
import {
  Fn, If, instanceIndex, uniform, uniformArray, storage, float, vec2, vec3, vec4, int, ivec2, uint, uvec4, hash, sin,
  cos, mix, clamp, smoothstep, textureLoad, texture, mx_noise_float, select, sqrt, atomicAdd, atomicStore, atomicLoad,
} from 'three/tsl';
import { minU } from './nanite/constants.ts';
import { curve, detailPos } from './planet.ts';
import { roadDistanceNode } from './road.ts';
import { meadowColourAt } from './terrain.ts';
import { floatAsUint, packHalf, packUnorm4 } from './three-gaps.ts';
import type { Bool, Float, Uint, Vec2 } from './types.ts';

const params = new URLSearchParams(location.search);
/** A blade grows in over this share of its keep chance (`?grassgrow=`, 0 = pops): popping in whole, walking forward
 * showed grass appearing ahead (the user); over 0.3 of it, blades rose within a metre or two of walking, a band of
 * them moving along ahead ("a redraw circle": `--sweep=detail` 53 -> 13 jumps on `meadow`, the same image). */
const GROW = Number(params.get('grassgrow') ?? 0.6);
const CLUMP = 0.8; // m: the tufts' grid (one jittered centre per cell)
/** How much the blades gather into tufts where grass is sparse / dense (`?grassclump=sparse,dense`, 0,0 = evenly). */
const [CLUMP_SPARSE, CLUMP_DENSE] = (params.get('grassclump') ?? '0.85,0').split(',').map(Number);
export const ARGS = 5; // uints of indexed indirect draw args per ring (index count, instances, first index, base vertex, first instance)
export const BLADE = 2; // uvec4s per kept blade

/** Patches of thicker and thinner grass (0..1). */
export const patchAt = (p: Vec2): Float => mx_noise_float(p.mul(0.045)).mul(0.5).add(0.5);

/** 0..1 from a whole-cell index and a salt. */
const cellHash = (c: Vec2, salt: number): Float =>
  hash(uint(int(c.x).add(1 << 20)).mul(73856093).bitXor(uint(int(c.y).add(1 << 20)).mul(19349663)).add(salt));

/**
 * The rings share their blades: ring k's cells are 2^k of the first ring's, and the blade of a ring-k cell is the
 * blade of one of its four ring-(k-1) cells (picked by a hash: `childOf`), down to a cell of the first ring, whose
 * hash makes the blade (position, height, colour...). So ring k-1, thinning out towards ring k, keeps exactly the
 * blades ring k has, and where they hand over each blade is drawn by one ring or the other, the same blade: with
 * blades of their own the rings' hand-overs were bands where one set sank and another rose, sliding along as you
 * walked (the user: "a line, only visible when moving").
 */
const childOf = (c: Vec2, level: number): Vec2 => {
  const h = cellHash(c, 977 + level * 131).mul(3.999).floor();
  return vec2(h.mod(2), h.div(2).floor());
};
/** The first ring's cell holding the blade of ring k's cell `ci`. */
function leafOf(ci: Vec2, k: number): Vec2 {
  let c = ci;
  for (let j = k; j > 0; j--) c = c.mul(2).add(childOf(c, j));
  return c;
}
/** Whether ring k's cell `c` holds the blade of its ring-(k+1) cell (kept to the end of the thinning). */
const isRep = (c: Vec2, k: number) => {
  const p = c.div(2).floor();
  const rc = p.mul(2).add(childOf(p, k + 1));
  return rc.x.equal(c.x).and(rc.y.equal(c.y));
};

/** The tuft a point belongs to: the nearest of the 4 jittered clump centres round it (its cell, centre, distance). */
function clumpOf(p: Vec2): { cell: Vec2; centre: Vec2; d: Float } {
  const g = p.div(CLUMP).sub(0.5).floor();
  let cell: Vec2 = g, centre: Vec2 = g.add(0.5).mul(CLUMP), d: Float = float(1e9);
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const c = g.add(vec2(i, j));
    const o = c.add(vec2(cellHash(c, 11), cellHash(c, 23)).mul(0.8).add(0.1)).mul(CLUMP);
    const dd = p.sub(o).length();
    const closer = dd.lessThan(d);
    cell = select(closer, c, cell);
    centre = select(closer, o, centre);
    d = d.min(dd);
  }
  return { cell, centre, d };
}

const ss = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface KeepRing {
  k: number;
  cell: number; // m
  radius: number; // m (scaled)
  inner: number; // the ring inside's radius (m), 0 for the first
  nextCell: number | null; // the next ring's cell (the morph's end)
  S: number; // cells a side per tile
  tiles: number; // tiles a side
  toGround: [number, number] | null; // the outermost ring: its blades turn to the ground's colour over this span (m)
}

/** The most blades a ring can keep: its cells where the cross-fade and the morph leave a chance, all of it (x1.3). */
export function ringCapacity(r: KeepRing): number {
  let sum = 0;
  const steps = 512, dr = r.radius / steps;
  for (let s = 0; s < steps; s++) {
    const d = (s + 0.5) * dr;
    const fade = (r.k === 0 ? 1 : ss(r.inner * 0.8, r.inner, d)) * (1 - ss(r.radius * 0.8, r.radius, d));
    const m = r.nextCell ? 1 + (r.nextCell / r.cell - 1) * ss(r.k === 0 ? 3 : r.inner, r.radius * 0.8, d) : 1;
    sum += (2 * Math.PI * d * dr * fade) / (m * m);
  }
  return Math.ceil((sum / (r.cell * r.cell)) * 1.3) + 1024;
}

export interface KeepContext {
  heights: THREE.DataTexture; // the terrain mesh's vertex heights
  size: number; // its side (m)
  segments: number;
  cover: { texture: THREE.Texture; extent: number }; // canopy cover (r cover, g fallen leaves)
  scale: number; // the rings' radii, x
  counters: ReturnType<typeof makeGrassCounters>;
}

/** Each ring's indirect draw args (ARGS uints a ring; the index count set, the blade count from the keep pass). */
export function makeGrassCounters(indexCounts: number[]) {
  const init = new Uint32Array(indexCounts.length * ARGS);
  indexCounts.forEach((n, k) => (init[k * ARGS] = n));
  const attr = new THREE.IndirectStorageBufferAttribute(init, 1);
  return { attr, atomic: storage(attr, 'uint', init.length).toAtomic() };
}

/** Zeroes every ring's blade count (before the keep passes), and clamps it to the list (after). */
export function countersPasses(c: KeepContext['counters'], caps: number[]) {
  const reset = Fn(() => {
    for (let k = 0; k < caps.length; k++) atomicStore(c.atomic.element(k * ARGS + 1), uint(0));
  })().compute(1, [1]);
  const clampCount = Fn(() => {
    for (let k = 0; k < caps.length; k++) {
      const e = c.atomic.element(k * ARGS + 1);
      atomicStore(e, minU(atomicLoad(e) as unknown as Uint, caps[k]));
    }
  })().compute(1, [1]);
  return { reset, clampCount };
}

/** Ground height and slope (|gradient|) at world xz: the terrain mesh's triangles (PlaneGeometry's split). */
function groundOf(ctx: KeepContext) {
  const n = ctx.segments + 1, step = ctx.size / ctx.segments;
  return (p: Vec2): { y: Float; slope: Float } => {
    const g = p.add(ctx.size / 2).div(step);
    const i = clamp(g.floor(), 0, n - 2), f = g.sub(i);
    const at = (dx: number, dz: number): Float => textureLoad(ctx.heights, ivec2(int(i.x).add(dx), int(i.y).add(dz))).x;
    const a = at(0, 0), b = at(0, 1), c = at(1, 1), d = at(1, 0);
    const upper = f.x.add(f.y).greaterThan(1);
    // (a, b, d) below the b-d diagonal, (b, c, d) above it
    const y = select(upper, c.add(b.sub(c).mul(float(1).sub(f.x))).add(d.sub(c).mul(float(1).sub(f.y))), a.add(d.sub(a).mul(f.x)).add(b.sub(a).mul(f.y)));
    const gx = select(upper, c.sub(b), d.sub(a)), gz = select(upper, c.sub(d), b.sub(a));
    return { y, slope: sqrt(gx.mul(gx).add(gz.mul(gz))).div(step) };
  };
}

/** A ring's inputs, set per frame by src/grass.ts: the grid's corner cell, the tiles in view, the camera's view. */
export function ringInputs(r: KeepRing) {
  const tileValues = Array.from({ length: r.tiles * r.tiles }, () => new THREE.Vector4());
  return {
    origin: uniform(new THREE.Vector2()), // the grid's corner cell (whole cells)
    tileValues,
    tiles: uniformArray<'vec4'>(tileValues, 'vec4'), // the tiles in view: their first cell (xy, from origin)
    count: uniform(0, 'uint'), // listed tiles x S x S
    view: uniform(new THREE.Matrix4()), // the camera's view matrix (blades behind it are dropped)
  };
}
export type RingInputs = ReturnType<typeof ringInputs>;

/**
 * The blade of a ring's cell (`index`: in the listed tiles, S x S cells each): whether it's drawn (kept, and not
 * behind the camera) and its shape. The compute pass lists the drawn ones (WebGPU); the WebGL mode, which has no
 * compute, runs it in the vertex shader and collapses the rest (src/grass.ts). Call inside a Fn.
 */
export function bladeOf(ctx: KeepContext, r: KeepRing, inp: RingInputs, index: Uint) {
  const { k, cell, radius, inner, S } = r;
  const ground = groundOf(ctx);
  const coverAt = (p: Vec2) => texture(ctx.cover.texture, p.div(ctx.cover.extent * 2).add(0.5));
  const local = index.mod(uint(S * S));
  const ci = vec2(float(local.mod(uint(S))), float(local.div(uint(S)))).add(inp.tiles.element(index.div(uint(S * S))).xy).add(inp.origin);
  const leaf = leafOf(ci, k).toVar(); // (the blade's own cell, in the first ring: see childOf)
  const seed = uint(int(leaf.x).add(1 << 22)).mul(73856093).bitXor(uint(int(leaf.y).add(1 << 22)).mul(19349663));
  const rnd = (j: number): Float => hash(seed.add(j * 101));
  const at = leaf.add(vec2(rnd(0), rnd(1))).mul(cell / 2 ** k);
  const patch = patchAt(at);
  // (thinner under the canopy, and where the fallen leaves lie thick: under the red trees most)
  const cv = coverAt(at);
  // (none on the road and the plaza: src/road.ts)
  const flat = smoothstep(0.1, 0.9, roadDistanceNode(at)).mul(float(1).sub(cv.r.mul(0.6))).mul(float(1).sub(cv.g.mul(1.4).min(1).mul(cv.r).mul(0.85))).mul(smoothstep(0.05, 0.45, patch)).toVar();
  // the tuft: how much blades gather into it (where grass is sparse; dense, it's an even carpet: pulled together,
  // a meadow was tufts with bare ground between), faded out by ~35 m, where a ring's cells get as big as tufts (by
  // the distance along the ground: from high up there's nothing left to see anyway); its blades are pulled a
  // little towards its centre
  const tuft = clumpOf(at);
  const near = float(1).sub(smoothstep(18 * ctx.scale, 34 * ctx.scale, at.sub(detailPos.xz).length()));
  const clumpy = mix(CLUMP_SPARSE, CLUMP_DENSE, smoothstep(0.1, 0.6, flat)).mul(near).toVar();
  const xz = mix(at, tuft.centre, clumpy.mul(0.3)).toVar();
  const g = ground(xz);
  const d = vec3(xz.x, g.y, xz.y).sub(detailPos).length(); // (3D: flying up, the grass thins out evenly)
  // the hand-over, over the inner ring's last 20%: each blade there is drawn by one ring or the other (by its own
  // chance `swap`); the outermost ring fades out to nothing over its own last 20%
  const fadeIn = k === 0 ? float(1) : smoothstep(inner * 0.8, inner, d);
  const fadeOut = float(1).sub(smoothstep(radius * 0.8, radius, d));
  const swap = rnd(11);
  const density = flat.mul(float(1).sub(smoothstep(0.45, 0.8, g.slope))).toVar();
  // the same share of blades, gathered: where it's sparse a share of whole tufts (each kept by its own chance),
  // full ones; in a tuft kept more near its centre, none past its edge (x1.7: the mean of `inTuft` over a cell
  // is ~0.6)
  const dn = tuft.d.div(mix(0.3, 0.5, cellHash(tuft.cell, 37)).mul(CLUMP)).toVar();
  const inTuft = float(1).sub(smoothstep(0.35, 1.05, dn));
  const tuftShare = density.mul(3).clamp(1e-3, 1);
  const tufted = select(cellHash(tuft.cell, 61).lessThan(tuftShare), density.div(tuftShare).mul(inTuft).mul(1.7), float(0));
  // thinning towards the next ring across this one, to its blades only (1 / m^2 of them, wider by m), so where they
  // hand over (the last 20%) both have the same blades
  const m = r.nextCell ? mix(1, 2, smoothstep(k === 0 ? 3 : inner, radius * 0.8, d)) : float(1);
  const thin = r.nextCell ? select(isRep(ci, k), float(1), float(4).div(m.mul(m)).sub(1).div(3).clamp(0, 1)) : fadeOut;
  const keep = mix(density, tufted, clumpy).mul(thin).toVar();
  let drawn: Bool = rnd(2).lessThan(keep);
  if (k > 0) drawn = drawn.and(swap.greaterThanEqual(float(1).sub(fadeIn)));
  if (r.nextCell) drawn = drawn.and(swap.lessThan(fadeOut));
  const base = vec3(xz.x, g.y.sub(0.04), xz.y).toVar();
  // (and those behind the camera: decided per blade, at the root)
  const behind = inp.view.mul(vec4(curve(base), 1)).z.greaterThan(1);
  // the blade (the compute pass computes it for the drawn ones only: its uses are inside an If)
  // how far it's grown: from nothing where it's just kept to full size a share GROW of the chance further in, so
  // the blades that come and go with the distance rise out of the ground and sink back instead of popping
  const grown = GROW > 0 ? clamp(keep.sub(rnd(2)).div(keep.mul(GROW).max(1e-4)), 0, 1) : float(1);
  // the blade: height (the tuft's and its own), width (wider in the outer rings: same covered fraction)
  const lush = smoothstep(0.3, 0.8, patch);
  const height = mix(0.22, 0.65, rnd(3)).mul(mix(0.6, 1.25, lush)).mul(mix(0.75, 1.25, cellHash(tuft.cell, 41))).mul(grown);
  const width = float(cell * 0.5).mul(m).mul(sqrt(grown));
  // leaning away from the tuft's centre (a fan), its own way where there's no tuft
  const yaw = rnd(4).mul(6.2832);
  const out = at.sub(tuft.centre);
  const lean = mix(vec2(sin(yaw).negate(), cos(yaw)), out.div(out.length().max(1e-4)), clumpy.mul(smoothstep(0.02, 0.1, out.length()))).normalize();
  // an arc: tilted at the root (the tuft's outer blades most), bending further along it
  const tilt = mix(0.05, 0.4, clamp(dn, 0, 1).mul(clumpy)).add(rnd(9).mul(0.15));
  const bendK = mix(0.2, 0.85, rnd(5)); // (the tip at most ~80 degrees over: further, blades lay flat as pale streaks)
  // colour: lighter and a little yellow at the tip, patches and tufts of drier grass
  const dry = smoothstep(0.55, 0.9, mx_noise_float(xz.mul(0.11).add(17)).mul(0.5).add(0.5)).mul(0.6).add(rnd(7).mul(0.25)).add(cellHash(tuft.cell, 53).sub(0.5).mul(0.3)).clamp(0, 1);
  // each blade its own green, from blue-green to yellow-green (one green for all read as a flat carpet)
  const hue = rnd(8);
  const green = mix(mix(vec3(0.2, 0.36, 0.17), vec3(0.33, 0.48, 0.12), smoothstep(0, 0.5, hue)), vec3(0.5, 0.58, 0.13), smoothstep(0.5, 1, hue));
  let tip = mix(green, vec3(0.58, 0.54, 0.25), dry).mul(mix(0.75, 1.15, rnd(10)));
  // sun through the blade, less under the canopy (in its shade, which the shadow map gives the surface light
  // only, a glow would stay); the root's darkening: deepest in a dense tuft
  let through: Float = float(1).sub(cv.r.mul(0.85));
  let rootDark: Float = mix(0.75, 0.45, density.mul(mix(1, inTuft, clumpy)));
  // the outermost ring's blades turn to the ground's own colour, unshaded, as they thin out, so the grass ends
  // in the plain ground rather than at a line (paler tips and darker roots than the ground: the user)
  if (r.toGround) {
    const far = smoothstep(r.toGround[0], r.toGround[1], d);
    tip = mix(tip, meadowColourAt(xz, g.slope), far);
    through = through.mul(float(1).sub(far));
    rootDark = mix(rootDark, 1, far);
  }
  return { drawn: drawn.and(behind.not()), base, height, width, lean, tilt, bendK, flutter: rnd(6), through, tip, rootDark };
}

/**
 * A ring's keep pass: a thread per cell of the tiles listed in `tiles` (`count` = listed tiles x S x S), appending
 * the kept blades to `list` (BLADE uvec4s each: root xyz, half(height, width); half(lean xz), half(tilt, bend),
 * half(flutter phase, sun through), unorm8(colour, root's darkening)).
 */
export function buildKeepPass(ctx: KeepContext, r: KeepRing, cap: number) {
  const inp = ringInputs(r);
  const listAttr = new THREE.StorageBufferAttribute(new Uint32Array(cap * BLADE * 4), 4);
  const list = storage(listAttr, 'uvec4', cap * BLADE);
  const ctr = ctx.counters.atomic.element(r.k * ARGS + 1);

  const pass = Fn(() => {
    If(instanceIndex.lessThan(inp.count), () => {
      const b = bladeOf(ctx, r, inp, instanceIndex);
      If(b.drawn, () => {
        const slot = atomicAdd(ctr, uint(1)).toVar();
        If(slot.lessThan(uint(cap)), () => {
          const bits = floatAsUint;
          list.element(slot.mul(BLADE)).assign(uvec4(bits(b.base.x), bits(b.base.y), bits(b.base.z), packHalf(vec2(b.height, b.width))));
          list.element(slot.mul(BLADE).add(1)).assign(uvec4(packHalf(b.lean), packHalf(vec2(b.tilt, b.bendK)), packHalf(vec2(b.flutter, b.through)), packUnorm4(vec4(b.tip, b.rootDark))));
        });
      });
    });
  })().compute(r.tiles * r.tiles * r.S * r.S, [64]);

  return { pass, listAttr, ...inp };
}
