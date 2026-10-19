// The ground's materials (src/terrain.ts's meshes), given their final shaders as soon as the terrain exists: they're
// the slowest to compile (~2 s on the dev machine, ~8 at a phone's pace), so they compile from there (src/warmup.ts),
// against their maps' textures before they're filled: the cover map (placement.ts forestDensity) and the litter map
// from the planting, the floor's maps from their workers (a texture filled in place is the same pipeline).
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
  applyFloor((terrain.getObjectByName('terrain') as StandardMesh).material, floorMaps, meadowColour(), coverMap, litter);
  applyFarFloor((terrain.getObjectByName('terrain-high') as StandardMesh).material, terrainDetail(terrain)); // (from high up)
  return { cover, litter, groundFar };
}
