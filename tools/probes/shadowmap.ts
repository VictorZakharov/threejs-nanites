// The sun's shadow map as the view left it (src/lighting.ts, follow): its size, its half-extents across the sun and
// up its direction (light space), and a texel's size on the ground both ways (up the sun: divided by sin(elevation)).
import type { Demo } from '../../src/harness-api.ts';
import type * as THREE from 'three/webgpu';

async (demo: Demo) => {
  demo.renderOnce();
  let sun: THREE.DirectionalLight | undefined;
  demo.scene.traverse((o) => void ((o as THREE.DirectionalLight).isDirectionalLight && (sun = o as THREE.DirectionalLight)));
  if (!sun) return { error: 'no directional light' };
  const c = sun.shadow.camera as THREE.OrthographicCamera, n = sun.shadow.mapSize.x;
  const d = sun.position.clone().sub(sun.target.position).normalize();
  const r = (v: number): number => +v.toFixed(3);
  return {
    size: n, across: r(c.right), up: r(c.top), elevation: r((Math.asin(d.y) * 180) / Math.PI),
    texelAcross: r((2 * c.right) / n), texelAlong: r((2 * c.top) / n / d.y),
    focus: [r(sun.target.position.x), r(sun.target.position.z)],
  };
}
