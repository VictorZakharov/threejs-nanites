import * as THREE from 'three/webgpu';
import { attribute, mix, vec3, positionWorld, float, mx_noise_float, smoothstep } from 'three/tsl';

// ---- deterministic value noise (shared by the terrain mesh and tree placement)
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function smooth(t) {
  return t * t * (3 - 2 * t);
}
function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
function fbm(x, y, oct) {
  let s = 0, amp = 1, f = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += valueNoise(x * f, y * f) * amp;
    n += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / n;
}


/** Terrain height in metres at world (x, z). */
export function heightAt(x, z) {
  const hills = fbm(x / 420 + 11.3, z / 420 - 7.1, 5) * 70 - 35;
  const ridges = Math.pow(1 - Math.abs(fbm(x / 900 - 3.7, z / 900 + 1.9, 3) * 2 - 1), 3) * 60;
  // keep the middle of the forest gently rolling
  const r = Math.hypot(x, z);
  const flatten = THREE.MathUtils.smoothstep(r, 150, 900);
  return hills * (0.35 + 0.65 * flatten) + ridges * flatten;
}

export function createTerrain(size) {
  const seg = 1024;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();
  // per-vertex grass/dirt mix from slope
  const nrm = geo.attributes.normal;
  const tint = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) tint[i] = 1 - THREE.MathUtils.smoothstep(nrm.getY(i), 0.8, 0.95);
  geo.setAttribute('slope', new THREE.BufferAttribute(tint, 1));

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const n1 = mx_noise_float(positionWorld.xz.mul(0.05)).mul(0.5).add(0.5);
  const n2 = mx_noise_float(positionWorld.xz.mul(0.6)).mul(0.5).add(0.5);
  const grassA = vec3(0.16, 0.22, 0.07);
  const grassB = vec3(0.24, 0.27, 0.1);
  const dirt = vec3(0.27, 0.22, 0.16);
  const grass = mix(grassA, grassB, n1).mul(float(0.85).add(n2.mul(0.3)));
  mat.colorNode = mix(grass, dirt, smoothstep(0.2, 0.8, attribute('slope', 'float').add(n2.mul(0.25).sub(0.1))));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}
