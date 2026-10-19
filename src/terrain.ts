import * as THREE from 'three/webgpu';
import { attribute, mix, vec3, vec4, positionWorld, positionLocal, float, mx_noise_float, smoothstep, texture, cameraViewMatrix } from 'three/tsl';
import type { Float, Vec2, Vec3 } from './types.ts';
import { curve } from './planet.ts';
import { fbm, heightAt } from './noise.ts';

// (the noise and the height live in noise.ts: plain TypeScript, shared with the planting workers)
export { fbm, heightAt };

/** Cells per side of the detailed terrain square (src/grass.ts reads its vertex heights). */
export const TERRAIN_SEGMENTS = 1024;

/** A grid for the terrain worker to build (terrain-worker.ts). */
export interface GridJob { size: number; seg: number; lowerInside: number; detail: boolean }
/** A built grid: PlaneGeometry's attributes laid on the height field, its slope, bounding sphere, detail texels. */
export interface GridData {
  position: Float32Array<ArrayBuffer>;
  normal: Float32Array<ArrayBuffer>;
  uv: Float32Array<ArrayBuffer>;
  index: Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>;
  slope: Float32Array<ArrayBuffer>; // per-vertex grass/dirt mix from the slope
  sphere: [number, number, number, number];
  texels: Uint8Array<ArrayBuffer> | null; // (the detailed square's: see detailMap)
}

/** Builds a grid in a worker: `seg` cells a side over `size` m (the skirt lowered under the square inside `lowerInside`). */
function terrainGeometry(size: number, seg: number, lowerInside = 0, detail = false): Promise<{ geo: THREE.BufferGeometry; texels: GridData['texels'] }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./terrain-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<GridData>) => {
      w.terminate();
      const d = e.data, geo = new THREE.BufferGeometry();
      geo.setIndex(new THREE.BufferAttribute(d.index, 1));
      geo.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
      geo.setAttribute('slope', new THREE.BufferAttribute(d.slope, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(d.sphere[0], d.sphere[1], d.sphere[2]), d.sphere[3]);
      resolve({ geo, texels: d.texels });
    };
    w.onerror = (e) => reject(new Error(e.message));
    const job: GridJob = { size, seg, lowerInside, detail };
    w.postMessage(job);
  });
}

/**
 * The ground's own colour: grass, dirt on the slopes (src/ground/floor.ts adds the forest floor near the viewer).
 * `slope`: the vertex's (or, on the coarse grids from high up, the detailed grid's, see `detail`).
 */
export function meadowColour(slope: Float = attribute('slope', 'float')) {
  return meadowColourAt(positionWorld.xz, slope);
}

/** The meadow colour at world xz `p` (also the far grass blades' colour, src/grass-keep.ts). */
export function meadowColourAt(p: Vec2, slope: Float): Vec3 {
  const n1 = mx_noise_float(p.mul(0.05)).mul(0.5).add(0.5);
  const n2 = mx_noise_float(p.mul(0.6)).mul(0.5).add(0.5);
  const grassA = vec3(0.16, 0.22, 0.07);
  const grassB = vec3(0.24, 0.27, 0.1);
  const dirt = vec3(0.27, 0.22, 0.16);
  const grass = mix(grassA, grassB, n1).mul(float(0.85).add(n2.mul(0.3)));
  return mix(grass, dirt, smoothstep(0.2, 0.8, slope.add(n2.mul(0.25).sub(0.1))));
}

function terrainMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  mat.colorNode = meadowColour();
  mat.positionNode = curve(positionLocal); // meshes sit at the origin: local = world
  return mat;
}

/**
 * From high up the near square is `terrain-high`: coarser grids by the height above the ground (m from, cells a
 * side), with the plain ground (src/ground/floor.ts applyFarFloor: what the floor comes to past 200 m). The 1024-cell
 * grid (~18 m cells) is ~2M triangles, over a pixel each from 9 km on a phone, and the floor's shader ran on all of it:
 * the phone spent 4.3 of 15.5 ms on the terrain and sky there. `?terrainhigh=0` keeps the detailed one everywhere.
 */
const HIGH: [number, number][] = [[350, TERRAIN_SEGMENTS], [1000, 512], [3000, 256], [6000, 128]];
const HIGH_ON = new URLSearchParams(location.search).get('terrainhigh') !== '0';

/**
 * Detailed square terrain of `size` (covers the forest) plus a coarse skirt out to ~65 km, so the curved horizon
 * seen from altitude is ground all the way. The skirt's cells line up with the square's edges.
 */
export async function createTerrain(size: number): Promise<THREE.Group> {
  // every grid in its own worker, all at once (started before the GPU is asked for: main.ts)
  const m = 2 * Math.ceil(65000 / size) + 1; // odd: the square sits exactly in the middle
  const [nearGrid, farGrid, ...coarse] = await Promise.all([
    terrainGeometry(size, TERRAIN_SEGMENTS, 0, true),
    terrainGeometry(size * m, 48 * m, size / 2),
    ...HIGH.filter(([, seg]) => seg !== TERRAIN_SEGMENTS).map(([, seg]) => terrainGeometry(size, seg)),
  ]);
  const group = new THREE.Group();
  const near = new THREE.Mesh(nearGrid.geo, terrainMaterial());
  near.receiveShadow = true;
  near.name = 'terrain';
  let c = 0;
  const levels = HIGH.map(([, seg]) => (seg === TERRAIN_SEGMENTS ? near.geometry : coarse[c++].geo));
  const high = new THREE.Mesh(levels[0], terrainMaterial());
  high.receiveShadow = true;
  high.name = 'terrain-high';
  high.visible = false;
  const far = new THREE.Mesh(farGrid.geo, terrainMaterial());
  far.material.polygonOffset = true; // loses depth ties against the detailed terrain
  far.material.polygonOffsetFactor = 2;
  far.material.polygonOffsetUnits = 8;
  far.name = 'terrain-far';
  group.add(near, high, far);
  group.userData.materials = [near.material, high.material, far.material];
  group.userData.high = { near, high, levels, level: -1 };
  group.userData.detail = detailMap(nearGrid.texels!, size);
  return group;
}

/**
 * The detailed grid's normals and slope as a texture over the square (rgb normal, a slope), so the coarse grids from
 * high up shade like it: with their own normals the hills read smoother and the ridges changed (`slope`, `phone9k`).
 */
function detailMap(data: Uint8Array<ArrayBuffer>, size: number) {
  const side = TERRAIN_SEGMENTS + 1; // (the texels: terrain-worker.ts)
  const tex = new THREE.DataTexture(data, side, side); // (row j: z = j cells from the -z edge; texel i: x)
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  // (vertex i sits at the centre of texel i)
  const t = texture(tex, positionWorld.xz.div(size).add(0.5).mul(TERRAIN_SEGMENTS / side).add(0.5 / side));
  const normal = t.xyz.mul(2).sub(1).normalize();
  return { slope: t.w, normalView: cameraViewMatrix.mul(vec4(normal, 0)).xyz.normalize() };
}

/** The coarse grids' shading inputs: the detailed grid's slope and view-space normal (see `detailMap`). */
export const terrainDetail = (group: THREE.Group): ReturnType<typeof detailMap> => group.userData.detail;

/**
 * Per frame: the near square's mesh for the camera's height above the ground (`altitude`, m); each step back down
 * at 85% of its height (no flipping at one height). `all`: both meshes, for compiling their shaders.
 */
export function terrainForAltitude(group: THREE.Group, altitude: number, all = false): void {
  const t = group.userData.high as { near: THREE.Mesh; high: THREE.Mesh; levels: THREE.BufferGeometry[]; level: number };
  let k = -1;
  if (HIGH_ON) for (let i = 0; i < HIGH.length; i++) if (altitude >= HIGH[i][0] * (t.level >= i ? 0.85 : 1)) k = i;
  t.level = k;
  t.near.visible = all || k < 0;
  t.high.visible = all || k >= 0;
  if (k >= 0) t.high.geometry = t.levels[k];
}
