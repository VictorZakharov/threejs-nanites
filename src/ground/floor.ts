// The ground near the viewer: the forest floor's maps (floor-maps.ts, last-stand's leaf litter, twigs and pebbles)
// with parallax relief (relief.ts). Under the canopy the litter shows; out in the open the ground keeps its grass
// colour, with the litter's detail, normals and relief in it. Moss patches are tinted in world space so the 5 m tile
// doesn't repeat visibly. Far away the maps' small mips are their average colour, which the colours are matched to.
import * as THREE from 'three/webgpu';
import {
  texture, positionWorld, cameraPosition, float, vec3, vec4, mix, smoothstep, mx_noise_float, normalWorld, cameraViewMatrix,
  select, dot,
} from 'three/tsl';
import type { Float, Vec2, Vec3, Vec4 } from '../types.ts';
import type { PBRData } from './floor-maps.ts';
import { reliefUv } from './relief.ts';

const TILE = 5; // m a tile (1024 px: ~5 mm a texel)
const RELIEF = { depth: 0.03, tile: TILE, fade: 40 };

export interface FloorMaps {
  map: THREE.DataTexture;
  normal: THREE.DataTexture;
  height: THREE.DataTexture;
  meanLum: number; // the albedo's mean luminance (linear): the meadow's detail is relative to it
}

/** Starts building the maps in a worker; resolves to textures. */
export function loadFloorMaps(): Promise<FloorMaps> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./floor-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<PBRData>) => {
      w.terminate();
      const d = e.data;
      const tex = (px: Uint8ClampedArray, srgb: boolean): THREE.DataTexture => {
        const t = new THREE.DataTexture(new Uint8Array(px.buffer), d.size, d.size);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        t.anisotropy = 8;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.needsUpdate = true;
        return t;
      };
      const lin = (c: number): number => (c / 255) ** 2.2;
      let sum = 0;
      for (let i = 0; i < d.albedo.length; i += 4) sum += lin(d.albedo[i]) * 0.3 + lin(d.albedo[i + 1]) * 0.55 + lin(d.albedo[i + 2]) * 0.15;
      resolve({ map: tex(d.albedo, true), normal: tex(d.normal, false), height: tex(d.rough, false), meanLum: sum / (d.albedo.length / 4) });
    };
    w.onerror = (e) => reject(new Error(e.message));
    w.postMessage(null);
  });
}

/**
 * Gives the terrain material the floor: `meadow` is its own (grass / dirt) colour, `cover` the cover map at the world
 * position (forestDensity: red the canopy cover 0..1, green the amount of fallen leaves, blue their autumn level / 2).
 */
export function applyFloor(mat: THREE.MeshStandardNodeMaterial, maps: FloorMaps, meadow: Vec3, coverMap: Vec4): void {
  // (the map's amount is blurred over the neighbouring stands and the pines, which drop none: x 1.4)
  const cover = coverMap.r, amount = coverMap.g.mul(1.4).min(1), hue = coverMap.b;
  const dist = positionWorld.sub(cameraPosition).length();
  // the leaves under each tree: as many as its kind drops (src/autumn.ts), the rest of the litter soil; up close by
  // each leaf's key (the maps' green), further away (where the mips average the keys) by the share
  const far = smoothstep(15, 45, dist);
  const lies = (key: Float): Float => mix(select(key.sub(0.1).div(0.9).lessThan(amount), float(1), float(0)), amount, far);
  const isLeaf = (key: Float): Float => smoothstep(0.02, 0.08, key);
  const sample = (t: THREE.Texture, p: Vec2, dx: Vec2, dy: Vec2): Float => {
    const s = texture(t, p).grad(dx, dy);
    return s.r.mul(mix(float(1), mix(float(0.4), float(1), lies(s.g)), isLeaf(s.g))); // (missing leaves sink to the soil)
  };
  const uv0 = positionWorld.xz.div(TILE);
  const under = smoothstep(0.3, 0.75, cover).mul(float(1).sub(smoothstep(80, 200, dist)));
  const uv = reliefUv(maps.height, uv0, RELIEF, sample, under); // (relief only in the litter)
  const dx = uv0.dFdx(), dy = uv0.dFdy();
  const raw = texture(maps.map, uv).grad(dx, dy).rgb.mul(2); // (last-stand's colours, for our light)
  const info = texture(maps.height, uv).grad(dx, dy);
  // fresh leaves take their trees' colour: yellow, then red (green trees' keep the browns)
  const lum = dot(raw, vec3(0.3, 0.59, 0.11));
  const turned = mix(vec3(2.4, 1.75, 0.25), vec3(2.5, 0.55, 0.2), smoothstep(0.55, 0.85, hue)).mul(lum);
  const leafCol = mix(raw, turned, smoothstep(0.2, 0.45, hue).mul(info.b.mul(0.6).add(0.4)));
  const soil = vec3(0.05, 0.032, 0.018).mul(mx_noise_float(positionWorld.xz.mul(2.3)).mul(0.25).add(1));
  const litter = mix(raw, mix(soil, leafCol, lies(info.g)), isLeaf(info.g));
  const nm = texture(maps.normal, uv).grad(dx, dy).xyz.mul(2).sub(1); // (r: -dh/du, g: +dh/dv, b: up)
  // moss over the litter in world space (large patches: a texture would tile)
  const p = positionWorld.xz;
  const mossV = mx_noise_float(p.mul(0.11)).mul(0.3).add(mx_noise_float(p.mul(0.37).add(7)).mul(0.15)).add(0.5);
  const moss = smoothstep(0.45, 0.7, mossV).mul(0.7);
  const mossCol = vec3(0.045, 0.09, 0.025).mul(mx_noise_float(p.mul(3.1)).mul(0.3).add(1));
  const floor = mix(litter, mossCol, moss);
  // under the canopy the litter, near the viewer (far away the ground's own colour, darkened by the far shading as
  // before: the litter's average brown turned the whole forest floor brown from the air); in the open the meadow
  // colour, varied by the litter's detail (its luminance relative to the mean, so the average stays the meadow's)
  // (the meadow keeps its plain colour: the litter's pattern in it read as pale stamped leaves up close)
  mat.colorNode = mix(meadow, floor, under);
  // the maps' normals on the terrain's (v runs along +z: dh/dz = g)
  const nW = normalWorld.add(vec3(nm.x, 0, nm.y.negate()).mul(under.mul(0.8))).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nW, 0)).xyz.normalize();
  mat.roughness = 0.95;
}
