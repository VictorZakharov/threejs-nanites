// Cobblestones for the road and the plaza (src/road.ts): a Voronoi pattern in world space, ~22 cm stones, each
// domed (the normal leans out towards its edges), its own grey-brown, dark soil in the joints with a little moss;
// far away (a pattern finer than the pixels) their average colour and a flat normal.
import { Fn, vec2, vec3, vec4, float, hash, smoothstep, mix, select, min, fwidth, mx_noise_float, int, uint } from 'three/tsl';
import type { Vec2, Vec3, Vec4 } from '../types.ts';

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
  const stone = smoothstep(0.05, 0.13, edge);
  const tone = mix(vec3(0.07, 0.065, 0.058), vec3(0.2, 0.18, 0.155), r).mul(mx_noise_float(p.mul(9)).mul(0.25).add(1));
  const joint = mix(vec3(0.025, 0.02, 0.014), vec3(0.03, 0.045, 0.018), smoothstep(0.2, 0.6, mx_noise_float(p.mul(1.3))));
  const near = float(1).sub(smoothstep(0.6, 1.4, fwidth(s.x).add(fwidth(s.y)))); // (pattern still resolved)
  const colour = mix(vec3(0.1, 0.09, 0.075), mix(joint, tone, stone), near);
  // domed: the normal leans out from the stone's middle, most near its edge
  const lean = float(1).sub(smoothstep(0.05, 0.4, edge)).mul(0.9).mul(near);
  return { colour, tilt: v.xy.normalize().mul(lean) };
}
