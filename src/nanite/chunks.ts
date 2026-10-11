// Coarse culling for the instance passes: the instances in runs of up to CHUNK consecutive ones (compact: the planting
// puts each tile's plants in Morton order, src/planting.ts), each with a box around its trees' bounding spheres. Per
// frame and view the CPU tests the boxes against the view (frustum, fog distance, the planet's curvature) and the
// instance pass runs over the visible chunks' instances only. It was a thread per instance, 2.5M, for the camera and
// again for the sun's shadow map, which covers a few hundred metres.
import * as THREE from 'three/webgpu';
import { PLANET_RADIUS } from '../planet.ts';

export const CHUNK = 2048; // instances (a power of two: the pass splits its thread index with a shift)
export const CHUNK_SHIFT = 11;
const EXTENT = 560; // m: a run is cut where its box would grow wider (into the next 512 m planting tile)
/** Two chunks a vec4 in a uniform array: under 64 KB (WebGPU's uniform binding limit) with room for the rest. */
export const MAX_CHUNKS = 7000;
const ALL = new URLSearchParams(location.search).get('chunks') === '0'; // (debug: every chunk, as if none were culled)

export class InstanceChunks {
  readonly count: number;
  readonly start: Uint32Array;
  readonly size: Uint32Array;
  readonly box: Float32Array; // per chunk: min x y z, max x y z (the spheres, uncurved)

  /** `a`, `b`: the instances (a: x y z scale, b: .., .., type, ..); `types`: (.., .., radius, height) per type. */
  constructor(a: Float32Array, b: Float32Array, types: THREE.Vector4[]) {
    // (a bigger forest: wider runs, so they fit the uniform array)
    let extent = EXTENT, r = InstanceChunks.runs(a, b, types, extent);
    while (r.start.length > MAX_CHUNKS) r = InstanceChunks.runs(a, b, types, (extent *= 1.5));
    this.count = r.start.length;
    this.start = Uint32Array.from(r.start);
    this.size = Uint32Array.from(r.size);
    this.box = Float32Array.from(r.box);
  }

  private static runs(a: Float32Array, b: Float32Array, types: THREE.Vector4[], extent: number) {
    const n = a.length / 4;
    const start: number[] = [], size: number[] = [], box: number[] = [];
    let x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0, k = 0;
    const close = () => box.push(x0, y0, z0, x1, y1, z1);
    for (let i = 0; i < n; i++) {
      const t = types[b[i * 4 + 2]], s = a[i * 4 + 3], r = t.z * s;
      const cx = a[i * 4], cy = a[i * 4 + 1] + t.w * 0.5 * s, cz = a[i * 4 + 2];
      if (k > 0 && (k === CHUNK || Math.max(x1, cx + r) - Math.min(x0, cx - r) > extent || Math.max(z1, cz + r) - Math.min(z0, cz - r) > extent)) {
        close();
        k = 0;
      }
      if (k === 0) {
        start.push(i);
        size.push(0);
        [x0, y0, z0, x1, y1, z1] = [cx - r, cy - r, cz - r, cx + r, cy + r, cz + r];
      } else {
        x0 = Math.min(x0, cx - r); y0 = Math.min(y0, cy - r); z0 = Math.min(z0, cz - r);
        x1 = Math.max(x1, cx + r); y1 = Math.max(y1, cy + r); z1 = Math.max(z1, cz + r);
      }
      size[size.length - 1] = ++k;
    }
    if (k > 0) close();
    return { start, size, box };
  }

  /**
   * The chunks a view can see, as (first instance, count) into `out`, two a vec4; returns how many. Conservative, as the
   * instance pass tests each tree: its curved centre's sphere in the frustum, its uncurved distance from `lodPos`
   * minus its radius under `maxDist`. `viewer`: whom the curvature drops points from (the main camera).
   */
  visible(frustum: THREE.Frustum, viewer: THREE.Vector3, lodPos: THREE.Vector3, maxDist: number, out: THREE.Vector4[]): number {
    let m = 0;
    const b = this.box, inv2R = 1 / (2 * PLANET_RADIUS), max2 = maxDist * maxDist;
    const { x: lx, y: ly, z: lz } = lodPos, { x: vx, z: vz } = viewer;
    const planes = frustum.planes;
    for (let c = 0, o = 0; c < this.count; c++, o += 6) {
      const x0 = b[o], y0 = b[o + 1], z0 = b[o + 2], x1 = b[o + 3], y1 = b[o + 4], z1 = b[o + 5];
      if (!ALL) {
        // nearest point of the box to the LOD origin, past the fog?
        const dx = Math.max(x0 - lx, 0, lx - x1), dy = Math.max(y0 - ly, 0, ly - y1), dz = Math.max(z0 - lz, 0, lz - z1);
        if (dx * dx + dy * dy + dz * dz > max2) continue;
        // the curvature drops each point by its squared horizontal distance from the viewer / 2R
        const nx = Math.max(x0 - vx, 0, vx - x1), nz = Math.max(z0 - vz, 0, vz - z1);
        const fx = Math.max(vx - x0, x1 - vx), fz = Math.max(vz - z0, z1 - vz);
        const ylo = y0 - (fx * fx + fz * fz) * inv2R, yhi = y1 - (nx * nx + nz * nz) * inv2R;
        // outside a plane: the box's corner furthest along the plane's normal is behind it (Frustum.intersectsBox)
        let inside = true;
        for (let p = 0; p < 6 && inside; p++) {
          const { normal: nrm, constant } = planes[p];
          const px = nrm.x > 0 ? x1 : x0, py = nrm.y > 0 ? yhi : ylo, pz = nrm.z > 0 ? z1 : z0;
          inside = nrm.x * px + nrm.y * py + nrm.z * pz + constant >= 0;
        }
        if (!inside) continue;
      }
      // (floats: whole numbers to 2^24, exact)
      const pair = out[m >> 1];
      if (m % 2 === 0) pair.set(this.start[c], this.size[c], 0, 0);
      else (pair.z = this.start[c]), (pair.w = this.size[c]);
      m++;
    }
    if (m === 0) out[0].set(0, 0, 0, 0); // (one empty chunk: the pass is still dispatched)
    return Math.max(m, 1);
  }
}
