// Which tree's leaves lie where, near the viewer: a 256 m square of half-metre texels round the camera, rebuilt from
// the instances as it moves (a grid of buckets finds the trees in it). Per texel: red the kind of leaf of the tree
// whose crown is most over it (floor-leaves.ts LEAF_KINDS + 1, 0 none), green how much has fallen there (by every
// crown over it: its kind's fallOf, needles thick), blue that tree's autumn level / 2. The floor (floor.ts) lays that
// kind's leaves in that tree's colour, so the litter matches the tree above in shape and colour (the user). Further
// out the cover map's averages take over.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { VARIANTS, isBush } from '../trees.ts';
import { autumnOfPhase, fallOf, NEEDLES } from '../autumn.ts';
import { LEAF_KINDS, type LeafKind } from './floor-leaves.ts';
import type { TreeInstances } from '../placement.ts';

export const LITTER_SIZE = 256; // m
export const LITTER_RES = 512; // texels a side
const MOVE = 32; // m the camera moves before a rebuild
const BUCKET = 64; // m

export function createLitterMap({ a, b, radius }: TreeInstances) {
  const N = LITTER_RES, cellM = LITTER_SIZE / N;
  const data = new Uint8Array(N * N * 4);
  const tex = new THREE.DataTexture(data, N, N);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  const center = uniform(new THREE.Vector2(1e9, 1e9)); // (world xz of the map's middle)
  const best = new Float32Array(N * N), amount = new Float32Array(N * N);
  const kindOf = VARIANTS.map((v) => LEAF_KINDS.indexOf(v.leaf as LeafKind) + 1);
  const reach = VARIANTS.map((v) => (isBush(v) ? v.height * 0.9 : v.height * 0.3) * 1.3); // m at scale 1

  // buckets of instance indices over the forest
  const side = Math.ceil((radius * 2.8) / BUCKET), origin = -side * BUCKET * 0.5;
  const counts = new Uint32Array(side * side + 1);
  const bucketOf = (x: number, z: number): number => {
    const bx = Math.floor((x - origin) / BUCKET), bz = Math.floor((z - origin) / BUCKET);
    return bx < 0 || bz < 0 || bx >= side || bz >= side ? -1 : bz * side + bx;
  };
  const count = a.length / 4;
  for (let i = 0; i < count; i++) { const k = bucketOf(a[i * 4], a[i * 4 + 2]); if (k >= 0) counts[k + 1]++; }
  for (let k = 0; k < side * side; k++) counts[k + 1] += counts[k];
  const items = new Uint32Array(counts[side * side]), fill = counts.slice(0, side * side);
  for (let i = 0; i < count; i++) { const k = bucketOf(a[i * 4], a[i * 4 + 2]); if (k >= 0) items[fill[k]++] = i; }

  function rebuild(cx: number, cz: number): void {
    data.fill(0);
    best.fill(0);
    amount.fill(0);
    const x0 = cx - LITTER_SIZE / 2, z0 = cz - LITTER_SIZE / 2, pad = 12;
    const b0 = Math.max(0, Math.floor((x0 - pad - origin) / BUCKET)), b1 = Math.min(side - 1, Math.floor((x0 + LITTER_SIZE + pad - origin) / BUCKET));
    const c0 = Math.max(0, Math.floor((z0 - pad - origin) / BUCKET)), c1 = Math.min(side - 1, Math.floor((z0 + LITTER_SIZE + pad - origin) / BUCKET));
    for (let bz = c0; bz <= c1; bz++) for (let bx = b0; bx <= b1; bx++) {
      const k = bz * side + bx;
      for (let j = counts[k]; j < counts[k + 1]; j++) {
        const i = items[j], type = b[i * 4 + 2], kind = kindOf[type];
        if (kind <= 0) continue;
        const s = a[i * 4 + 3], R = reach[type] * s, turn = autumnOfPhase(b[i * 4 + 3]);
        const fall = LEAF_KINDS[kind - 1] === 'pine' ? NEEDLES : fallOf(turn) * 1.2;
        const tx = (a[i * 4] - x0) / cellM, tz = (a[i * 4 + 2] - z0) / cellM, rt = R / cellM;
        const xa = Math.max(0, Math.floor(tx - rt)), xb = Math.min(N - 1, Math.ceil(tx + rt));
        const za = Math.max(0, Math.floor(tz - rt)), zb = Math.min(N - 1, Math.ceil(tz + rt));
        for (let z = za; z <= zb; z++) for (let x = xa; x <= xb; x++) {
          const d = Math.hypot(x + 0.5 - tx, z + 0.5 - tz) / rt;
          if (d >= 1) continue;
          const w = (1 - d) * (1 - d) * (0.5 + 0.5 * s), p = z * N + x;
          amount[p] += w * fall;
          if (w > best[p]) {
            best[p] = w;
            data[p * 4] = kind;
            data[p * 4 + 2] = Math.round(Math.min(1, turn / 2) * 255);
          }
        }
      }
    }
    for (let p = 0; p < N * N; p++) data[p * 4 + 1] = Math.round(Math.min(1, amount[p] * 1.6) * 255);
    tex.needsUpdate = true;
    center.value.set(cx, cz);
  }

  return {
    texture: tex,
    center,
    /** Rebuilds round the camera once it has moved MOVE metres (skipped high up: the litter is gone by 200 m). */
    update(cam: THREE.Vector3, agl: number): void {
      if (agl > 220) return;
      if (Math.hypot(cam.x - center.value.x, cam.z - center.value.y) < MOVE) return;
      rebuild(Math.round(cam.x / cellM) * cellM, Math.round(cam.z / cellM) * cellM);
    },
  };
}
