// A cloud deck at ~2.2 km: three stacked sheets sampling one tileable fbm noise texture (cheap: a few texture
// fetches per pixel, no ray marching). From the ground it's an overcast-with-gaps sky, from above a white floor
// you can fly through, which is what tells you how high you are. The sheets follow the camera and get the planet's
// curvature, so the deck bends down to the horizon with the ground.
import * as THREE from 'three/webgpu';
import { texture, uniform, vec2, vec3, vec4, float, positionWorld, positionLocal, smoothstep, mix, select } from 'three/tsl';
import { dropAt, viewerPos } from './planet.js';

export const CLOUD_BASE = 2200;
const SIZE = 512;

function noiseTexture() {
  // tileable value-noise fbm, 5 octaves
  const hash = (x, y, p) => {
    x = ((x % p) + p) % p;
    y = ((y % p) + p) % p;
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const sm = (t) => t * t * (3 - 2 * t);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      let v = 0, amp = 0.5, norm = 0;
      for (let o = 0; o < 5; o++) {
        const period = 4 << o; // lattice cells per tile at this octave
        const fx = (x / SIZE) * period, fy = (y / SIZE) * period;
        const ix = Math.floor(fx), iy = Math.floor(fy), tx = sm(fx - ix), ty = sm(fy - iy);
        const a = hash(ix, iy, period), b = hash(ix + 1, iy, period), c = hash(ix, iy + 1, period), d = hash(ix + 1, iy + 1, period);
        v += (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty) * amp;
        norm += amp;
        amp *= 0.5;
      }
      const i = (y * SIZE + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round((v / norm) * 255);
      data[i + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, SIZE, SIZE);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function createClouds() {
  const tex = noiseTexture();
  const time = uniform(0);
  const offset = uniform(new THREE.Vector3()); // the group's position (the sheets follow the camera)
  const group = new THREE.Group();
  const layers = [
    { y: CLOUD_BASE, cut: 0.47, alpha: 0.6 },
    { y: CLOUD_BASE + 60, cut: 0.44, alpha: 0.75 },
    { y: CLOUD_BASE + 120, cut: 0.47, alpha: 0.6 },
  ];
  for (const L of layers) {
    // 90 km sheet with enough vertices to bend with the curvature
    const geo = new THREE.PlaneGeometry(90000, 90000, 96, 96);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, L.y, 0);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    // world-space uv (the sheet follows the camera, the pattern stays put and drifts with the wind)
    const uv = positionWorld.xz.add(vec2(time.mul(9), time.mul(4))).div(14000);
    const n = texture(tex, uv).r.mul(0.7).add(texture(tex, uv.mul(4.3).add(0.37)).r.mul(0.3));
    const cover = smoothstep(L.cut, L.cut + 0.12, n);
    // lit tops, grey undersides: which one you see depends on whether you're above the deck
    const below = viewerPos.y.lessThan(L.y);
    const shade = select(below, mix(float(0.62), float(0.9), n), mix(float(0.95), float(1.15), n));
    mat.colorNode = vec4(vec3(shade).mul(vec3(1.0, 0.99, 0.97)), cover.mul(L.alpha));
    // curvature from the world position (local + the group's offset), applied in local space
    mat.positionNode = positionLocal.sub(vec3(0, dropAt(positionLocal.add(offset)), 0));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    mesh.name = 'clouds';
    group.add(mesh);
  }
  return {
    group,
    update(t, cam) {
      time.value = t;
      // follow the camera (snapped, so the vertex grid doesn't swim)
      const snap = 900;
      group.position.set(Math.round(cam.position.x / snap) * snap, 0, Math.round(cam.position.z / snap) * snap);
      offset.value.copy(group.position);
    },
  };
}
