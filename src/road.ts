// The cobblestone road (the user: "a cobblestone road through the forest towards an open area with a circle of
// statues"): from the spawn point, winding ~80 m through the forest to a round paved plaza ringed by statues.
// Shared by placement (no trees or bushes on it), the grass (none on it) and the floor (cobbles: ground/cobbles.ts):
// the shaders read a distance map (metres to the paving's edge, negative inside) over the road's bounding square.
import * as THREE from 'three/webgpu';
import { texture, float, vec2 } from 'three/tsl';
import type { Float, Vec2 } from './types.ts';

export const ROAD_WIDTH = 3.6; // m
export const SPAWN = { x: 20, z: 40, yaw: 30 }; // (main.ts's start: looking down the road)
const LENGTH = 80; // (240 at first: the user wanted it 3x shorter)
const fwd = { x: -Math.sin((SPAWN.yaw * Math.PI) / 180), z: -Math.cos((SPAWN.yaw * Math.PI) / 180) };
const side = { x: -fwd.z, z: fwd.x };

/** The road's centre line, spawn to plaza (a gentle S, straight at both ends). */
export const ROAD: { x: number; z: number }[] = Array.from({ length: 33 }, (_, i) => {
  const t = i / 32, along = (t - 0.02) * LENGTH;
  const wiggle = Math.sin(t * Math.PI) ** 2 * Math.sin(t * Math.PI * 2) * LENGTH * 0.11;
  return { x: SPAWN.x + fwd.x * along + side.x * wiggle, z: SPAWN.z + fwd.z * along + side.z * wiggle };
});
/** The plaza at the road's end: paved radius, and the circle the statues stand on. */
export const PLAZA = (() => {
  const end = ROAD[ROAD.length - 1];
  return { x: end.x + fwd.x * 22, z: end.z + fwd.z * 22, radius: 24, ring: 17, statues: 12 };
})();

/** Metres from (x, z) to the paving's edge (road or plaza), negative on it. */
export function roadDistance(x: number, z: number): number {
  let d = Math.hypot(x - PLAZA.x, z - PLAZA.z) - PLAZA.radius;
  for (let i = 0; i + 1 < ROAD.length; i++) {
    const a = ROAD[i], b = ROAD[i + 1];
    const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2));
    d = Math.min(d, Math.hypot(x - a.x - ex * t, z - a.z - ez * t) - ROAD_WIDTH / 2);
  }
  return d;
}

// the distance map: 25 cm texels over the road's bounding square (+ a margin); far outside it reads "far away"
const RES = 1024;
const box = (() => {
  const xs = [...ROAD.map((p) => p.x), PLAZA.x - PLAZA.radius, PLAZA.x + PLAZA.radius];
  const zs = [...ROAD.map((p) => p.z), PLAZA.z - PLAZA.radius, PLAZA.z + PLAZA.radius];
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const half = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2 + 12;
  return { cx, cz, half };
})();
const FAR = 8; // m: distances are clamped here

let mapTex: THREE.DataTexture | null = null;
function roadMap(): THREE.DataTexture {
  if (mapTex) return mapTex;
  // (half floats: linear filtering of 32-bit float textures is an optional WebGPU feature)
  const data = new Uint16Array(RES * RES);
  for (let j = 0; j < RES; j++)
    for (let i = 0; i < RES; i++) {
      const x = box.cx - box.half + ((i + 0.5) / RES) * box.half * 2, z = box.cz - box.half + ((j + 0.5) / RES) * box.half * 2;
      data[j * RES + i] = THREE.DataUtils.toHalfFloat(Math.max(-FAR, Math.min(FAR, roadDistance(x, z))));
    }
  mapTex = new THREE.DataTexture(data, RES, RES, THREE.RedFormat, THREE.HalfFloatType);
  mapTex.magFilter = mapTex.minFilter = THREE.LinearFilter;
  mapTex.needsUpdate = true;
  return mapTex;
}

/** In a shader: metres from world xz `p` to the paving's edge (negative on it; FAR outside the map). */
export function roadDistanceNode(p: Vec2): Float {
  const uv = p.sub(vec2(box.cx - box.half, box.cz - box.half)).div(box.half * 2);
  const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
  return inside.select(texture(roadMap(), uv).r, float(FAR));
}
