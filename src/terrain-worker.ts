// One terrain grid off the main thread (terrain.ts): a PlaneGeometry laid on the height field (noise.ts), its normals
// and slope, and for the detailed square the detail map's texels. ~0.8 s of the main thread while loading (~3 s at a
// phone's speed); three.js's own PlaneGeometry and normals, so the same vertices as before to the bit.
import { PlaneGeometry, MathUtils } from 'three';
import { heightAt } from './noise.ts';
import type { GridJob, GridData } from './terrain.ts';

self.onmessage = (e: MessageEvent<GridJob>) => {
  const { size, seg, lowerInside, detail } = e.data;
  const geo = new PlaneGeometry(size, size, seg, seg);
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
  geo.computeBoundingSphere();
  // per-vertex grass/dirt mix from slope
  const nrm = geo.attributes.normal;
  const slope = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) slope[i] = 1 - MathUtils.smoothstep(nrm.getY(i), 0.8, 0.95);
  // the detailed grid's normals and slope as texels (terrain.ts detailMap)
  let texels: Uint8Array<ArrayBuffer> | null = null;
  if (detail) {
    texels = new Uint8Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      texels[i * 4] = Math.round((nrm.getX(i) * 0.5 + 0.5) * 255);
      texels[i * 4 + 1] = Math.round((nrm.getY(i) * 0.5 + 0.5) * 255);
      texels[i * 4 + 2] = Math.round((nrm.getZ(i) * 0.5 + 0.5) * 255);
      texels[i * 4 + 3] = Math.round(slope[i] * 255);
    }
  }
  const s = geo.boundingSphere!;
  const out: GridData = {
    position: pos.array as Float32Array<ArrayBuffer>,
    normal: nrm.array as Float32Array<ArrayBuffer>,
    uv: geo.attributes.uv.array as Float32Array<ArrayBuffer>,
    index: geo.index!.array as Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>,
    slope,
    sphere: [s.center.x, s.center.y, s.center.z, s.radius],
    texels,
  };
  const transfer: Transferable[] = [out.position.buffer, out.normal.buffer, out.uv.buffer, out.index.buffer, slope.buffer];
  if (texels) transfer.push(texels.buffer);
  (self as unknown as Worker).postMessage(out, transfer);
};
