// The cobblestone road (the user: "a cobblestone road through the forest towards an open area with a circle of
// statues"): from the spawn point, winding ~80 m through the forest to a round paved plaza ringed by statues.
// Shared by placement (no trees or bushes on it), the grass (none on it) and the floor (cobbles: ground/cobbles.ts):
// the shaders read a distance map (metres to the paving's edge, negative inside) over the road's bounding square.
import * as THREE from 'three/webgpu';
import { texture, float, vec2 } from 'three/tsl';
import type { Float, Vec2 } from './types.ts';
import { ROAD, PLAZA, ROAD_WIDTH, segmentDistance } from './road-path.ts';

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
  // Each piece of paving (the plaza, each segment) only writes the texels within FAR of it: the others read FAR
  // (clamped) whatever the rest of the road. The same values as asking roadDistance per texel, which looped over
  // every segment for a million texels: 0.7 s of the main thread while loading.
  const dist = new Float32Array(RES * RES).fill(FAR);
  const size = box.half * 2, x0 = box.cx - box.half, z0 = box.cz - box.half;
  const piece = (minX: number, maxX: number, minZ: number, maxZ: number, d: (x: number, z: number) => number): void => {
    const i0 = Math.max(0, Math.floor(((minX - FAR - x0) / size) * RES - 0.5)), i1 = Math.min(RES - 1, Math.ceil(((maxX + FAR - x0) / size) * RES - 0.5));
    const j0 = Math.max(0, Math.floor(((minZ - FAR - z0) / size) * RES - 0.5)), j1 = Math.min(RES - 1, Math.ceil(((maxZ + FAR - z0) / size) * RES - 0.5));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = x0 + ((i + 0.5) / RES) * size, z = z0 + ((j + 0.5) / RES) * size;
        const k = j * RES + i;
        dist[k] = Math.min(dist[k], d(x, z));
      }
  };
  piece(PLAZA.x - PLAZA.radius, PLAZA.x + PLAZA.radius, PLAZA.z - PLAZA.radius, PLAZA.z + PLAZA.radius, (x, z) => Math.hypot(x - PLAZA.x, z - PLAZA.z) - PLAZA.radius);
  for (let s = 0; s + 1 < ROAD.length; s++) {
    const a = ROAD[s], b = ROAD[s + 1], w = ROAD_WIDTH / 2;
    piece(Math.min(a.x, b.x) - w, Math.max(a.x, b.x) + w, Math.min(a.z, b.z) - w, Math.max(a.z, b.z) + w, (x, z) => segmentDistance(x, z, s));
  }
  // (half floats: linear filtering of 32-bit float textures is an optional WebGPU feature)
  const data = new Uint16Array(RES * RES);
  for (let k = 0; k < data.length; k++) data[k] = THREE.DataUtils.toHalfFloat(Math.max(-FAR, Math.min(FAR, dist[k])));
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
