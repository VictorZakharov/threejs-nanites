// The ground's materials (src/terrain.ts's meshes), given their final shaders as soon as the terrain exists, against
// their maps' textures before they're filled: the cover map (placement.ts forestDensity) and the litter map from the
// planting, the floor's maps from their workers (a texture filled in place is the same pipeline). The forest floor's
// shader is the slowest to compile (~1.5 s of the GPU process on the dev machine): the near square starts with the
// ground from high up (what the floor comes to past 200 m) and gets the floor once it's compiled, after the first
// frame (main.ts).
import * as THREE from 'three/webgpu';
import { float, positionWorld, texture, uniform } from 'three/tsl';
import { applyFloor, applyFarFloor, type FloorMaps } from './floor.ts';
import { createLitterMap } from './litter-map.ts';
import { createCoverMap, type CoverMap } from '../placement.ts';
import { meadowColour, terrainDetail } from '../terrain.ts';
import type { Float } from '../types.ts';

type StandardMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;

/**
 * `radius`: the forest's (the cover map's extent); `receivedShadow(far)`: the shadow node fading to `far` past the
 * shadow map (lighting.ts makeFadeShadow). Returns the (empty) cover and litter maps and the ground's far shading.
 */
export function setupGround(terrain: THREE.Group, floorMaps: FloorMaps, radius: number, receivedShadow: (far: Float) => () => THREE.Node) {
  const cover: CoverMap = createCoverMap(radius);
  // darkened by how much canopy stands over it
  const groundShade = uniform(Number(new URLSearchParams(location.search).get('groundshade') ?? 0.7));
  const coverMap = texture(cover.texture, positionWorld.xz.div(cover.extent * 2).add(0.5));
  const groundFar = float(1).sub(coverMap.r.mul(groundShade));
  for (const m of terrain.userData.materials as THREE.NodeMaterial[]) m.receivedShadowNode = receivedShadow(groundFar);
  // the forest floor near the viewer: leaf litter under the canopy, parallax relief
  const litter = createLitterMap(); // (which tree's leaves lie where near the viewer)
  const near = terrain.getObjectByName('terrain') as StandardMesh, high = terrain.getObjectByName('terrain-high') as StandardMesh;
  const floor = near.material;
  applyFloor(floor, floorMaps, meadowColour(), coverMap, litter);
  applyFarFloor(high.material, terrainDetail(terrain)); // (from high up)
  near.material = high.material; // (until the floor is compiled)
  return { cover, litter, groundFar, near, floor };
}
