// Imports a high-poly model for the Nanite renderer: reads a PLY, glTF / GLB or OBJ (by the file's extension; the
// readers are in model-input/: a glTF's or OBJ's meshes merged into one, node transforms applied, materials ignored),
// stands it up (its longest axis, a glTF's y, or --up=x|y|z|-x|-y|-z), centres it on its base, decimates it to --tris
// with meshoptimizer and writes a compact model file for the site (public/models/<name>.nm): positions quantized to
// 14 bits, and its cluster DAG built here at --height (metres, the variant's: the LOD errors are in metres), all
// meshopt-compressed (src/nanite-lib/model/encode.ts). The site only decodes it (decode.ts); it's read back to check.
//
//   node tools/nanite-model.ts <in.ply|.gltf|.glb|.obj> --name=lucy --tris=1000000 --height=4 [--up=z] [--attr=n,uv]
//   node tools/nanite-model.ts public/models/lucy.nm --height=4     (a built file: its folds, see folds())
//   node tools/nanite-model.ts public/models/lucy.nm --reencode     (a built file rewritten in the current format:
//                                                                    14-bit positions, packed records: nothing rebuilt)
//
// Very large scans (Lucy: 28M triangles) are first merged on a vertex grid down to ~4x the target (meshopt's
// simplifier on the full scan needs more memory than wasm has), then simplified properly.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readPly } from './model-input/ply.ts';
import { readGltf } from './model-input/gltf.ts';
import { readObj } from './model-input/obj.ts';
import type { LoadedModel } from '../src/nanite-lib/model/decode.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args: Record<string, string | undefined> = Object.fromEntries(process.argv.slice(3).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const input = process.argv[2];

/**
 * Triangles that face against their own vertices' normals (rebuilt from the faces, src/nanite-lib/model/source.ts): a
 * fold of the scan or of the simplification lying back over its neighbours. Lit by its normals it's black (a dark
 * sliver on a statue's face, the user). Over the full-detail mesh and over every level's triangles.
 */
function folds(vtx: Float32Array, idx: Uint32Array): number {
  let n = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 8, idx[t + 1] * 8, idx[t + 2] * 8];
    const ux = vtx[b] - vtx[a], uy = vtx[b + 1] - vtx[a + 1], uz = vtx[b + 2] - vtx[a + 2];
    const vx = vtx[c] - vtx[a], vy = vtx[c + 1] - vtx[a + 1], vz = vtx[c + 2] - vtx[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = vtx[a + 4] + vtx[b + 4] + vtx[c + 4], my = vtx[a + 5] + vtx[b + 5] + vtx[c + 5], mz = vtx[a + 6] + vtx[b + 6] + vtx[c + 6];
    if (nx * mx + ny * my + nz * mz < 0) n++;
  }
  return n;
}
/** '' if the file's records `r` stand for the built ones `p`: the same errors and levels, each sphere holding its own. */
function recordsHold(p: Float32Array, r: Float32Array): string {
  if (p.length !== r.length) return `${r.length / 16} clusters, built ${p.length / 16}`;
  for (let c = 0; c < p.length / 16; c++) {
    for (const k of [12, 13, 14, 15]) if (p[c * 16 + k] !== r[c * 16 + k]) return `cluster ${c}: errors, level or kind differ`;
    for (let j = 0; j < 3; j++) {
      const at = c * 16 + j * 4, d = Math.hypot(p[at] - r[at], p[at + 1] - r[at + 1], p[at + 2] - r[at + 2]);
      if (d + p[at + 3] > r[at + 3] * (1 + 1e-6) + 1e-6) return `cluster ${c}: sphere ${j} doesn't hold the built one`;
    }
  }
  return '';
}
/**
 * '' if the file's coarse copy (format 4) is its model's coarsest levels, cluster for cluster: the same triangles over
 * the same positions and uvs, the same records (but its finest level's error, 0), normals within the octahedral step.
 */
async function coarseHolds(file: Uint8Array, full: LoadedModel, height: number): Promise<string> {
  const { decodeCoarse, readHeader } = await import('../src/nanite-lib/model/decode.ts');
  const level = readHeader(file)?.coarse?.level, c = await decodeCoarse(file, height);
  if (level === undefined) return ''; // (a model too small for one)
  if (!c) return 'no coarse copy';
  const f = full.dag, d = c.dag;
  let k = 0;
  for (let fc = 0; fc < f.meta.length / 4; fc++) {
    if (f.meta[fc * 4 + 2] < level) continue;
    for (let j = 1; j < 4; j++) if (f.meta[fc * 4 + j] !== d.meta[k * 4 + j]) return `coarse cluster ${k}: meta differs`;
    for (let j = 0; j < 16; j++) if (d.rec[k * 16 + j] !== (j === 12 && f.meta[fc * 4 + 2] === level ? 0 : f.rec[fc * 16 + j])) return `coarse cluster ${k}: record differs`;
    // (corner for corner up to the index codec's rotation)
    const same = (ft: number, dt: number, r: number): boolean => {
      for (let m = 0; m < 3; m++) {
        const a = f.idx[ft + m] * 8, b = d.idx[dt + ((m + r) % 3)] * 8;
        for (let j = 0; j < 8; j++) if (Math.abs(f.vtx[a + j] - d.vtx[b + j]) > (j >= 4 && j < 7 ? 1e-3 : 0)) return false;
      }
      return true;
    };
    for (let t = 0; t < f.meta[fc * 4 + 1] * 3; t += 3) {
      const ft = f.meta[fc * 4] + t, dt = d.meta[k * 4] + t;
      if (!same(ft, dt, 0) && !same(ft, dt, 1) && !same(ft, dt, 2)) return `coarse cluster ${k}: triangle ${t / 3} differs`;
    }
    k++;
  }
  return k === d.meta.length / 4 ? '' : `${d.meta.length / 4} coarse clusters, ${k} expected`;
}
if (input?.endsWith('.nm') && args.reencode) {
  const { reencodeModel } = await import('../src/nanite-lib/model/encode.ts');
  const { decodeModel } = await import('../src/nanite-lib/model/decode.ts');
  const before = new Uint8Array(readFileSync(input)), after = await reencodeModel(before);
  // (read back: the same triangles, corner for corner up to the codec's rotation, each corner within the new
  // quantization's step of where it was; the same errors; each sphere holding the one it stands for)
  const [a, b] = [await decodeModel(before, 4), await decodeModel(after, 4)];
  const tol = 4 / 2 ** 13; // (metres at height 4: half a 14-bit step plus half a 16-bit one, with room)
  const near = (t: number, r: number): boolean => {
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) if (Math.abs(a.dag.vtx[a.dag.idx[t + k] * 8 + j] - b.dag.vtx[b.dag.idx[t + (k + r) % 3] * 8 + j]) > tol) return false;
    return true;
  };
  for (let t = 0; t < a.dag.idx.length; t += 3) if (!near(t, 0) && !near(t, 1) && !near(t, 2)) throw new Error(`triangle ${t / 3} moved after re-encoding`);
  const bad = recordsHold(a.dag.rec, b.dag.rec) || (await coarseHolds(after, b, 4));
  if (bad) throw new Error(bad);
  writeFileSync(input, after);
  console.log(`${input}: ${(before.length / 1e6).toFixed(2)} -> ${(after.length / 1e6).toFixed(2)} MB, every triangle within a step, every sphere holding the old, the coarse copy its coarsest levels`);
  process.exit(0);
}
if (input?.endsWith('.nm')) {
  const { decodeModel } = await import('../src/nanite-lib/model/decode.ts');
  const { dag, src } = await decodeModel(new Uint8Array(readFileSync(input)), Number(args.height ?? 4));
  const level0 = src.bark.idx;
  const vtx0 = dag.vtx;
  console.log(`${input}: ${folds(vtx0, level0).toLocaleString()} of ${(level0.length / 3).toLocaleString()} full-detail triangles face against their normals; ${folds(vtx0, dag.idx).toLocaleString()} of ${(dag.idx.length / 3).toLocaleString()} over every level`);
  process.exit(0);
}
if (!input || !args.name) {
  console.log('usage: node tools/nanite-model.ts <in.ply|.gltf|.glb|.obj> --name=NAME [--tris=1000000] [--height=1] [--up=z] [--attr=1,1]');
  process.exit(1);
}
const target = Number(args.tris ?? 1e6);
const t0 = performance.now();
const log = (s: string): void => console.log(`${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${s}`);

// ---------------------------------------------------------------- vertex-grid merge (for huge scans)
function gridMerge(pos: Float32Array, idx: Uint32Array, cells: number): { pos: Float32Array; idx: Uint32Array } {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]); }
  const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]), step = ext / cells;
  const map = new Map<number, number>(), remap = new Uint32Array(pos.length / 3), sum: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const key = Math.floor((pos[i * 3] - mn[0]) / step) + Math.floor((pos[i * 3 + 1] - mn[1]) / step) * 65536 + Math.floor((pos[i * 3 + 2] - mn[2]) / step) * 4294967296;
    let v = map.get(key);
    if (v === undefined) { v = sum.length / 4; map.set(key, v); sum.push(0, 0, 0, 0); }
    remap[i] = v;
    sum[v * 4] += pos[i * 3]; sum[v * 4 + 1] += pos[i * 3 + 1]; sum[v * 4 + 2] += pos[i * 3 + 2]; sum[v * 4 + 3]++;
  }
  const np = new Float32Array(sum.length / 4 * 3);
  for (let v = 0; v < sum.length / 4; v++) for (let k = 0; k < 3; k++) np[v * 3 + k] = sum[v * 4 + k] / sum[v * 4 + 3];
  const out: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    out.push(a, b, c);
  }
  return { pos: np, idx: Uint32Array.from(out) };
}

// ---------------------------------------------------------------- main
await MeshoptSimplifier.ready;
const kind = extname(input).toLowerCase();
const read = { '.ply': () => readPly(readFileSync(input)), '.gltf': () => readGltf(readFileSync(input), input), '.glb': () => readGltf(readFileSync(input), input), '.obj': () => readObj(readFileSync(input)) }[kind];
if (!read) throw new Error(`${input}: .ply, .gltf, .glb or .obj`);
let { pos, idx } = await read();
log(`read ${input}: ${(pos.length / 3).toLocaleString()} vertices, ${(idx.length / 3).toLocaleString()} triangles`);

// stand it up: the up axis to +y (the longest extent unless --up), base at y = 0, centred in x and z, height 1
const ext = [0, 1, 2].map((k) => { let a = Infinity, b = -Infinity; for (let i = k; i < pos.length; i += 3) { a = Math.min(a, pos[i]); b = Math.max(b, pos[i]); } return [a, b]; });
// (glTF is y up by definition)
const up: string = args.up ?? (kind === '.gltf' || kind === '.glb' ? 'y' : undefined) ?? ['x', 'y', 'z'][[0, 1, 2].sort((a, b) => (ext[b][1] - ext[b][0]) - (ext[a][1] - ext[a][0]))[0]];
const ax = ({ x: 0, y: 1, z: 2 } as Record<string, number>)[up.replace('-', '')], sign = up.startsWith('-') ? -1 : 1;
if (ax === undefined) throw new Error(`--up=${up}: x, y, z, -x, -y or -z`);
const others = [0, 1, 2].filter((k) => k !== ax);
{
  const h = ext[ax][1] - ext[ax][0], base = sign > 0 ? ext[ax][0] : ext[ax][1];
  const c0 = (ext[others[0]][0] + ext[others[0]][1]) / 2, c1 = (ext[others[1]][0] + ext[others[1]][1]) / 2;
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    // (a right-handed turn: (others[0], up, others[1]) -> (x, y, z), flipping one axis when up is negative)
    out[i] = (pos[i + others[0]] - c0) / h;
    out[i + 1] = ((pos[i + ax] - base) * sign) / h;
    out[i + 2] = ((pos[i + others[1]] - c1) / h) * (ax === 1 ? 1 : -1) * sign;
  }
  pos = out;
  log(`up axis ${up}, scaled to height 1`);
}

if (idx.length / 3 > target * 4) {
  // merge on a grid fine enough to keep ~4x the target
  const cells = Math.round(Math.sqrt(target * 4 / 2) * 1.8);
  ({ pos, idx } = gridMerge(pos, idx, cells));
  log(`grid merge (${cells} cells): ${(pos.length / 3).toLocaleString()} vertices, ${(idx.length / 3).toLocaleString()} triangles`);
}
if (idx.length / 3 > target) {
  const [res, err] = MeshoptSimplifier.simplify(idx, pos, 3, Math.floor(target) * 3, 1, ['ErrorAbsolute']);
  idx = res;
  log(`simplified: ${(idx.length / 3).toLocaleString()} triangles (error ${(err * 1000).toFixed(3)} / 1000 of the height)`);
}
// the model file (src/nanite-lib/model/encode.ts): vertices reordered, positions quantized, the cluster DAG built from
// the very floats the site decodes, at the height it's shown at
const { encodeModel } = await import('../src/nanite-lib/model/encode.ts');
const { decodeModel } = await import('../src/nanite-lib/model/decode.ts');
const height = Number(args.height ?? 1);
// --attr=n,uv: the simplifier's normal and uv weights x these (src/nanite-lib/dag/build.ts BARK_WEIGHTS): heavier
// normals switch later, so the shading jumps less at each switch, for more triangles
const attr = (args.attr ?? '1,1').split(',').map(Number) as [number, number];
const { file, header: head, dag } = await encodeModel(pos, idx, { height, attr, source: args.source ?? '' });
const unique = head.vertices;
log(`${unique.toLocaleString()} vertices after reordering`);
log(`DAG at ${height} m: ${head.clusters.toLocaleString()} clusters, ${dag.stats.barkLevels + 1} levels, ${dag.stats.barkRoots} roots, ${dag.stats.ms} ms`);
const outDir = join(root, 'public', 'models');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${args.name}.nm`);
writeFileSync(out, file);
log(`wrote ${out}: ${(file.length / 1e6).toFixed(2)} MB (positions ${(head.vertexBytes / 1e6).toFixed(2)}, DAG triangles ${(head.indexBytes / 1e6).toFixed(2)}, clusters ${((head.recBytes + (head.errBytes ?? 0) + head.metaBytes) / 1e6).toFixed(2)})`);

// read it back as the site does
const back = await decodeModel(file, height);
const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
// positions and uvs exact; normals summed in another order (a vertex whose faces nearly cancel can turn round)
let dv = 0, turned = 0;
for (let i = 0; i < dag.vtx.length; i++) {
  const d = Math.abs(dag.vtx[i] - back.dag.vtx[i]), k = i % 8;
  if (k === 4 || k === 5 || k === 6) { if (d > 1e-3 && k === 4) turned++; else if (d > 1e-3) continue; }
  else dv = Math.max(dv, d);
}
console.log(`  ${turned} of ${unique.toLocaleString()} normals differ (summed in another order)`);
// (the index codec may rotate a triangle's corners, keeping its winding: compare each from its smallest corner)
const canon = (a: Uint32Array): Uint32Array => {
  const o = new Uint32Array(a.length);
  for (let t = 0; t < a.length; t += 3) {
    const r = a[t] <= a[t + 1] && a[t] <= a[t + 2] ? 0 : a[t + 1] <= a[t + 2] ? 1 : 2;
    for (let k = 0; k < 3; k++) o[t + k] = a[t + ((r + k) % 3)];
  }
  return o;
};
const held = recordsHold(dag.rec, back.dag.rec) || (await coarseHolds(file, back, height));
if (!same(canon(dag.idx), canon(back.dag.idx)) || held || !same(dag.meta, back.dag.meta) || dv > 1e-5 || turned > unique * 1e-4) {
  console.error(`round trip FAILED (largest position/uv difference ${dv}, ${turned} normals; same triangles ${same(canon(dag.idx), canon(back.dag.idx))}, records ${held || 'held'}, meta ${same(dag.meta, back.dag.meta)})`);
  process.exit(1);
}
log(`round trip ok`);
