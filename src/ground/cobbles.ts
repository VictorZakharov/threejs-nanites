// Cobblestones for the road and the plaza (src/road.ts): a Voronoi pattern in world space, ~22 cm stones, each
// domed (the normal leans out towards its edges), its own grey-brown, dark soil in the joints with a little moss;
// far away (a pattern finer than the pixels) their average colour and a flat normal.
import { Fn, vec2, vec3, vec4, float, hash, smoothstep, mix, select, min, fwidth, mx_noise_float, int, uint, length, dFdx, dFdy } from 'three/tsl';
import type { Vec2, Vec3, Vec4 } from '../types.ts';
import { footprint } from '../nanite/shading.ts';

const CELL = 0.22; // m

/** The nearest stone at cell coordinates `s`: (offset from its middle x, y, edge = F2 - F1, its random 0..1). */
const voronoi = Fn(([s]: [Vec2]) => {
  const cell = s.floor(), f = s.fract();
  const d1 = float(9).toVar(), d2 = float(9).toVar(), r = float(0).toVar();
  const toward = vec2(0).toVar();
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const c = cell.add(vec2(i, j));
      const seed = uint(int(c.x).add(4096)).mul(73856093).bitXor(uint(int(c.y).add(4096)).mul(19349663));
      const pt = vec2(i, j).add(vec2(hash(seed), hash(seed.add(7))).mul(0.7).add(0.15));
      const v = f.sub(pt), d = v.length();
      const closer = d.lessThan(d1);
      d2.assign(select(closer, d1, min(d2, d)));
      r.assign(select(closer, hash(seed.add(13)), r));
      toward.assign(select(closer, v, toward));
      d1.assign(min(d1, d));
    }
  return vec4(toward, d2.sub(d1), r);
});

/** Cobble colour and the world-space normal's lean (x, z) at world xz `p`. */
export function cobbles(p: Vec2): { colour: Vec3; tilt: Vec2 } {
  const s = p.div(CELL);
  const v = (voronoi(s) as unknown as Vec4).toVar();
  const edge = v.z, r = v.w;
  // the pixel's footprint in stones, by its area (the longest side, along the road at a grazing angle, faded the
  // stones out ~10 m ahead: a washed-out grey band, the user); TAA averages what's left of the aliasing
  const px = length(dFdx(s)).mul(length(dFdy(s))).sqrt().mul(footprint()); // (for the output's pixels)
  const aa = fwidth(edge).mul(footprint()).max(0.02);
  const stone = smoothstep(float(0.09).sub(aa), float(0.09).add(aa), edge);
  const tone = mix(vec3(0.07, 0.065, 0.058), vec3(0.2, 0.18, 0.155), r).mul(mx_noise_float(p.mul(9)).mul(0.25).add(1));
  const joint = mix(vec3(0.025, 0.02, 0.014), vec3(0.03, 0.045, 0.018), smoothstep(0.2, 0.6, mx_noise_float(p.mul(1.3))));
  // far away: their average, in patches (worn / dirty) so the paving doesn't turn into one flat strip
  const patches = mx_noise_float(p.mul(0.35)).mul(0.25).add(mx_noise_float(p.mul(1.1).add(5)).mul(0.12)).add(1);
  const average = vec3(0.078, 0.07, 0.059).mul(patches); // (darker than the mean albedo: the domed normals shade the near stones)
  const near = float(1).sub(smoothstep(0.8, 2.5, px)); // (pattern still resolved)
  const colour = mix(average, mix(joint, tone.mul(patches), stone), near);
  // domed: the normal leans out from the stone's middle, most near its edge
  const lean = float(1).sub(smoothstep(0.05, 0.4, edge)).mul(0.9).mul(near);
  return { colour, tilt: v.xy.normalize().mul(lean) };
}
