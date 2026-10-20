// Cobblestones for the road and the plaza (src/road.ts): a Voronoi pattern in world space, ~22 cm stones, each
// domed (the normal leans out towards its edges), its own grey-brown, dark soil in the joints with a little moss;
// far away (a pattern finer than the pixels) their average colour and a flat normal. The floor (floor.ts) computes the
// stones only where they show, inside a branch: the derivatives are taken before it (`cobbleFootprint`), and the
// joints' antialiasing takes the edge's derivative from the two nearest stones rather than from the GPU.
import { vec2, vec3, float, hash, smoothstep, mix, select, min, mx_noise_float, int, uint, length, dFdx, dFdy, abs, dot } from 'three/tsl';
import type { Float, Vec2, Vec3 } from '../types.ts';
import { footprint } from '../nanite-lib/index.ts';

const CELL = 0.22; // m

/** The pixel's footprint over the stones (taken in uniform control flow): the cell coordinates' derivatives and
 * `px`, the footprint in stones by its area (the longest side, along the road at a grazing angle, faded the stones
 * out ~10 m ahead: a washed-out grey band, the user). */
export interface CobbleFootprint { dx: Vec2; dy: Vec2; px: Float }
export function cobbleFootprint(p: Vec2): CobbleFootprint {
  const s = p.div(CELL);
  const dx = dFdx(s).mul(footprint()).toVar(), dy = dFdy(s).mul(footprint()).toVar(); // (for the output's pixels)
  return { dx, dy, px: length(dx).mul(length(dy)).sqrt().toVar() };
}
/** Over this footprint (in stones) the pattern is gone: the average colour, a flat normal. */
export const COBBLES_GONE = 2.5;

/** The nearest stone at cell coordinates `s`: the offset from its middle, the edge (F2 - F1), the edge's gradient
 * (in cell units) and its random 0..1. */
function voronoi(s: Vec2): { toward: Vec2; edge: Float; grad: Vec2; r: Float } {
  const cell = s.floor(), f = s.fract();
  const d1 = float(9).toVar(), d2 = float(9).toVar(), r = float(0).toVar();
  const toward = vec2(0).toVar(), second = vec2(0, 1).toVar();
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const c = cell.add(vec2(i, j));
      const seed = uint(int(c.x).add(4096)).mul(73856093).bitXor(uint(int(c.y).add(4096)).mul(19349663));
      const pt = vec2(i, j).add(vec2(hash(seed), hash(seed.add(7))).mul(0.7).add(0.15));
      const v = f.sub(pt).toVar(), d = v.length().toVar();
      const closer = d.lessThan(d1).toVar();
      second.assign(select(closer, toward, select(d.lessThan(d2), v, second)));
      d2.assign(select(closer, d1, min(d2, d)));
      r.assign(select(closer, hash(seed.add(13)), r));
      toward.assign(select(closer, v, toward));
      d1.assign(min(d1, d));
    }
  return { toward, edge: d2.sub(d1), grad: second.div(d2.max(1e-5)).sub(toward.div(d1.max(1e-5))), r };
}

/** Worn and dirty patches over the paving (a brightness factor at world xz `p`). */
export const cobblePatches = (p: Vec2): Float => mx_noise_float(p.mul(0.35)).mul(0.25).add(mx_noise_float(p.mul(1.1).add(5)).mul(0.12)).add(1);
/** The paving's colour far away (finer than the pixels): the stones' average in its patches, so it doesn't turn into
 * one flat strip; darker than their mean albedo: the domed normals shade the near stones. */
export const cobbleAverage = (patches: Float): Vec3 => vec3(0.078, 0.07, 0.059).mul(patches);

/** Cobble colour and the world-space normal's lean (x, z) at world xz `p`, its footprint `fp` (cobbleFootprint).
 * Needs no derivatives: it can be built inside a branch. */
export function cobbles(p: Vec2, fp: CobbleFootprint): { colour: Vec3; tilt: Vec2 } {
  const v = voronoi(p.div(CELL));
  const edge = v.edge, r = v.r;
  // (fwidth(edge), from its gradient: TAA averages what's left of the aliasing)
  const aa = abs(dot(v.grad, fp.dx)).add(abs(dot(v.grad, fp.dy))).max(0.02);
  const stone = smoothstep(float(0.09).sub(aa), float(0.09).add(aa), edge);
  const tone = mix(vec3(0.07, 0.065, 0.058), vec3(0.2, 0.18, 0.155), r).mul(mx_noise_float(p.mul(9)).mul(0.25).add(1));
  const joint = mix(vec3(0.025, 0.02, 0.014), vec3(0.03, 0.045, 0.018), smoothstep(0.2, 0.6, mx_noise_float(p.mul(1.3))));
  const patches = cobblePatches(p);
  const average = cobbleAverage(patches);
  const near = float(1).sub(smoothstep(0.8, COBBLES_GONE, fp.px)); // (pattern still resolved)
  const colour = mix(average, mix(joint, tone.mul(patches), stone), near);
  // domed: the normal leans out from the stone's middle, most near its edge
  const lean = float(1).sub(smoothstep(0.05, 0.4, edge)).mul(0.9).mul(near);
  return { colour, tilt: v.toward.normalize().mul(lean) };
}
