// Parallax occlusion for the ground (after last-stand's core/parallax.ts, in TSL): the floor's height map is read
// along the view ray, so the soil between the leaves, twigs and pebbles lies sunk below their tops and shifts against
// them as the view moves. Only the hollows sink: the tops stay at the terrain's own level, where the grass, the trees
// and the shadows are. The steps are a uniform (0 = off: the menu switch compiles nothing); the relief fades out with
// distance, where it's too fine to see.
import { Fn, Loop, If, Break, float, vec2, uniform, select, smoothstep, max, mix, clamp, cameraPosition, positionWorld, dFdx, dFdy } from 'three/tsl';
import type * as THREE from 'three/webgpu';
import type { Float, Vec2 } from '../types.ts';

const MAX_STEPS = 16;
/** Steps down the view ray (looking straight down takes half); 0 turns the relief off (`?relief=0`; off on touch). */
const params = new URLSearchParams(location.search);
export const reliefSteps = uniform(Number(params.get('relief') ?? (matchMedia('(pointer: coarse)').matches ? 0 : MAX_STEPS)));
export const RELIEF_STEPS = MAX_STEPS;

export interface Relief {
  depth: number; // m: the lowest point under the tops
  tile: number; // m a tile of the maps
  fade: number; // m: gone by this distance
}

/**
 * Where the view ray through this pixel meets the relief, as a uv of the maps (uv = world xz / tile). `height` holds
 * the height in its red channel (1 the tops). The gradients are the plain uv's: inside the loop the GPU's are undefined.
 */
export function reliefUv(height: THREE.Texture, uv: Vec2, r: Relief, sample: (t: THREE.Texture, p: Vec2, dx: Vec2, dy: Vec2) => Float): Vec2 {
  return Fn(() => {
    const dx = dFdx(uv), dy = dFdy(uv);
    const toEyeRaw = cameraPosition.sub(positionWorld);
    const dist = toEyeRaw.length();
    const toEye = toEyeRaw.div(max(dist, 1e-4));
    const depth = float(r.depth).mul(float(1).sub(smoothstep(r.fade * 0.6, r.fade, dist)));
    const result = uv.toVar();
    If(reliefSteps.greaterThan(0).and(depth.greaterThan(0)).and(toEye.y.greaterThan(0)), () => {
      // a metre down the ray moves it this far over the ground, in uv (away from the eye)
      const slide = vec2(toEye.x, toEye.z).negate().div(max(toEye.y, 0.25)).div(r.tile);
      const n = max(1, mix(reliefSteps.mul(0.5), reliefSteps, float(1).sub(toEye.y)).floor());
      const layer = float(1).div(n);
      const stepUv = slide.mul(depth).mul(layer);
      const at = uv.toVar(), ray = float(0).toVar();
      const surface = float(1).sub(sample(height, at, dx, dy)).toVar();
      const found = float(0).toVar();
      Loop(MAX_STEPS, ({ i }) => {
        If(float(i).greaterThanEqual(n), () => Break());
        const next = at.add(stepUv), nextRay = ray.add(layer);
        const nextSurface = float(1).sub(sample(height, next, dx, dy));
        If(nextRay.greaterThanEqual(nextSurface), () => {
          const above = surface.sub(ray), below = nextRay.sub(nextSurface);
          result.assign(at.add(stepUv.mul(clamp(above.div(max(above.add(below), 1e-4)), 0, 1))));
          found.assign(1);
          Break();
        });
        at.assign(next);
        ray.assign(nextRay);
        surface.assign(nextSurface);
      });
      result.assign(select(found.greaterThan(0), result, at));
    });
    return result;
  })();
}
