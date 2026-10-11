import * as THREE from 'three/webgpu';
import { attribute, mix, vec3, positionWorld, positionLocal, float, mx_noise_float, smoothstep } from 'three/tsl';
import { curve } from './planet.ts';
import { fbm, heightAt } from './noise.ts';

// (the noise and the height live in noise.ts: plain TypeScript, shared with the planting workers)
export { fbm, heightAt };

/** Cells per side of the detailed terrain square (src/grass.ts reads its vertex heights). */
export const TERRAIN_SEGMENTS = 1024;

function terrainGeometry(size: number, seg: number, lowerInside = 0): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    let y = heightAt(x, z);
    // the outer skirt hides under the detailed terrain (its boundary vertices stay exact, so the seam matches)
    if (lowerInside && Math.abs(x) < lowerInside - 1 && Math.abs(z) < lowerInside - 1) y -= 150;
    pos.setY(i, y);
  }
  geo.computeVertexNormals();
  // per-vertex grass/dirt mix from slope
  const nrm = geo.attributes.normal;
  const tint = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) tint[i] = 1 - THREE.MathUtils.smoothstep(nrm.getY(i), 0.8, 0.95);
  geo.setAttribute('slope', new THREE.BufferAttribute(tint, 1));
  return geo;
}

/** The ground's own colour: grass, dirt on the slopes (src/ground/floor.ts adds the forest floor near the viewer). */
export function meadowColour() {
  const n1 = mx_noise_float(positionWorld.xz.mul(0.05)).mul(0.5).add(0.5);
  const n2 = mx_noise_float(positionWorld.xz.mul(0.6)).mul(0.5).add(0.5);
  const grassA = vec3(0.16, 0.22, 0.07);
  const grassB = vec3(0.24, 0.27, 0.1);
  const dirt = vec3(0.27, 0.22, 0.16);
  const grass = mix(grassA, grassB, n1).mul(float(0.85).add(n2.mul(0.3)));
  return mix(grass, dirt, smoothstep(0.2, 0.8, attribute('slope', 'float').add(n2.mul(0.25).sub(0.1))));
}

function terrainMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  mat.colorNode = meadowColour();
  mat.positionNode = curve(positionLocal); // meshes sit at the origin: local = world
  return mat;
}

/**
 * Detailed square terrain of `size` (covers the forest) plus a coarse skirt out to ~65 km, so the curved horizon
 * seen from altitude is ground all the way. The skirt's cells line up with the square's edges.
 */
export function createTerrain(size: number): THREE.Group {
  const group = new THREE.Group();
  const near = new THREE.Mesh(terrainGeometry(size, TERRAIN_SEGMENTS), terrainMaterial());
  near.receiveShadow = true;
  near.name = 'terrain';
  const m = 2 * Math.ceil(65000 / size) + 1; // odd: the square sits exactly in the middle
  const far = new THREE.Mesh(terrainGeometry(size * m, 48 * m, size / 2), terrainMaterial());
  far.material.polygonOffset = true; // loses depth ties against the detailed terrain
  far.material.polygonOffsetFactor = 2;
  far.material.polygonOffsetUnits = 8;
  far.name = 'terrain-far';
  group.add(near, far);
  group.userData.materials = [near.material, far.material];
  return group;
}
