// What the view would cost without Nanite: every plant in the view frustum (within the view distance, the planet's
// curve applied) drawn at full detail, as plain frustum culling and one mesh per tree type would draw it. Counted on
// the CPU from the instances and each type's full-detail triangles (DAG level 0); too many to draw for a timing (the
// cluster lists hold 1M clusters). Compare with the triangles Nanite draws (the benchmark's tris + swTris + 2 per
// impostor) and, for a time, with a small forest drawn at full detail (README: tau=0.01&imppx=0&occ=0&sw=0).
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const f = demo.forest, cam = demo.camera;
  cam.updateMatrixWorld();
  const P = cam.projectionMatrix.elements, V = cam.matrixWorldInverse.elements;
  // clip = P x V (column-major), its rows give the frustum planes
  const M = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) M[c * 4 + r] += P[k * 4 + r] * V[c * 4 + k];
  const row = (r: number): number[] => [M[r], M[4 + r], M[8 + r], M[12 + r]];
  const planes: number[][] = [];
  for (const [r, s] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
    const a = row(3), b = row(r), p = a.map((v, i) => v + s * b[i]);
    const l = Math.hypot(p[0], p[1], p[2]);
    planes.push(p.map((v) => v / l));
  }
  const types = f.stats.types.map((t) => t.barkTris + t.leafTris);
  const ti = f.typeInfo.array as { z: number; w: number }[], inst = f.inst.value.array, n = f.instanceCount;
  const maxDist = f.u.maxDist.value, R2 = 2 * f.ctrLayout.PLANET_RADIUS, cx = cam.position.x, cz = cam.position.z;
  let plants = 0, tris = 0, trees = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 8, s = inst[a + 3], t = inst[a + 6], info = ti[t];
    const dx = inst[a] - cx, dz = inst[a + 2] - cz, d2 = dx * dx + dz * dz;
    if (d2 > maxDist * maxDist) continue;
    const x = inst[a], y = inst[a + 1] + (info.w / 2) * s - d2 / R2, z = inst[a + 2], rad = info.z * s;
    let inside = true;
    for (const p of planes) if (p[0] * x + p[1] * y + p[2] * z + p[3] < -rad) { inside = false; break; }
    if (!inside) continue;
    plants++;
    if (i < f.treeCount) trees++;
    tris += types[t];
  }
  return { plantsInView: plants, treesInView: trees, fullDetailTris: tris, fullDetailBillions: +(tris / 1e9).toFixed(2), viewDistance: Math.round(maxDist) };
}
