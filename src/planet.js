// "Planet" curvature: the world is flat in data (terrain, tree positions), and bent in the vertex shaders: a point
// at horizontal distance d from the viewer drops by d^2 / 2R, which is how a sphere of radius R looks from the
// viewer's position. Everything that's drawn (terrain, clusters, impostors, shadow casters, clouds) and the GPU
// culling go through the same function, so the horizon is a curve and nothing is culled where it's shown.
import { uniform, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';

export const PLANET_RADIUS = Number(new URLSearchParams(location.search).get('planet') ?? 150000);

/** The viewer's world position: set each frame from the main camera (not the shadow camera). */
export const viewerPos = uniform(new THREE.Vector3());
const invTwoR = uniform(1 / (2 * PLANET_RADIUS));

/** Curvature drop (m) at horizontal distance from the viewer. */
export function dropAt(p) {
  const dx = p.x.sub(viewerPos.x), dz = p.z.sub(viewerPos.z);
  return dx.mul(dx).add(dz.mul(dz)).mul(invTwoR);
}

/** World position as seen on the planet. */
export function curve(p) {
  return vec3(p.x, p.y.sub(dropAt(p)), p.z);
}

/** CPU version, e.g. for placing the camera or the sun. */
export function dropAtCPU(x, z, vx, vz) {
  const dx = x - vx, dz = z - vz;
  return (dx * dx + dz * dz) / (2 * PLANET_RADIUS);
}
