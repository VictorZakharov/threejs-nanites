// A cluster DAG's cut on the CPU: the triangles a uniform error selects, as the GPU's cluster pass would at the
// distance where that error projects to tau. The impostor bake draws trees at their switch-size cut
// (impostors/atlas.ts), and a renderer without compute (the demo's WebGL mode) draws fixed cuts as instanced meshes.
import type { DagResult } from './types.ts';

/** A triangle mesh (positions, normals, uvs, indices) in the source meshes' form. */
export interface MeshPart {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  idx: Uint32Array;
}

/**
 * The triangles of one mesh at a uniform DAG cut: every cluster whose own error is within `err` (object space,
 * metres) and whose parent's isn't, as the runtime cut selects them at a distance where `err` projects to tau.
 * Returns { bark, leaves }, each { pos, nrm, uv, idx } (vertices shared, from the packed [x y z u nx ny nz v]).
 */
export function dagCut(t: DagResult, err: number): { bark: MeshPart; leaves: MeshPart } {
  const nv = t.vtx.length / 8;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let i = 0; i < nv; i++) {
    const v = t.vtx.subarray(i * 8, i * 8 + 8);
    pos.set([v[0], v[1], v[2]], i * 3);
    nrm.set([v[4], v[5], v[6]], i * 3);
    uv.set([v[3], v[7]], i * 2);
  }
  const lists: number[][] = [[], []]; // bark, leaves
  const n = t.meta.length / 4;
  for (let c = 0; c < n; c++) {
    const own = t.rec[c * 16 + 12], parent = t.rec[c * 16 + 13];
    if (!(own <= err && parent > err)) continue;
    const o = t.meta[c * 4], tris = t.meta[c * 4 + 1], kind = t.meta[c * 4 + 3];
    for (let k = 0; k < tris * 3; k++) lists[kind].push(t.idx[o + k]);
  }
  const part = (l: number[]): MeshPart => ({ pos, nrm, uv, idx: new Uint32Array(l) });
  return { bark: part(lists[0]), leaves: part(lists[1]) };
}
