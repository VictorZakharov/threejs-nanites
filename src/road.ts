// The cobblestone road (the user: "a cobblestone road through the forest towards an open area with a circle of
// statues"): from the spawn point, winding ~80 m through the forest to a round paved plaza ringed by statues.
// Shared by placement (no trees or bushes on it), the grass (none on it) and the floor (cobbles: ground/cobbles.ts):
// the shaders read a distance map (metres to the paving's edge, negative inside) over the road's bounding square.
import * as THREE from 'three/webgpu';
import { texture, float, vec2 } from 'three/tsl';
import type { Float, Vec2 } from './types.ts';
import { ROAD, PLAZA, roadDistance } from './road-path.ts';

// (the shape and the distance: road-path.ts, shared with the planting workers)
export { ROAD, PLAZA, ROAD_WIDTH, SPAWN, roadDistance } from './road-path.ts';

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
