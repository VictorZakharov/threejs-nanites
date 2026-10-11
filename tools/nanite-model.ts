// Imports a high-poly model for the Nanite renderer: reads a PLY (binary either endianness, or ASCII; triangles or
// polygons), stands it up (its longest axis, or --up=x|y|z|-x|-y|-z), centres it on its base, decimates it to --tris
// with meshoptimizer and writes a compact model file for the site (public/models/<name>.nm): positions quantized to
// 16 bits, and its cluster DAG (src/dag-build.ts) built here at --height (metres, the variant's: the LOD errors are
// in metres), all meshopt-compressed. The site only decodes it (src/models.ts); the file is read back to check.
//
//   node tools/nanite-model.ts <in.ply> --name=lucy --tris=1000000 --height=4 [--up=z]
//
// Very large scans (Lucy: 28M triangles) are first merged on a vertex grid down to ~4x the target (meshopt's
// simplifier on the full scan needs more memory than wasm has), then simplified properly.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args: Record<string, string | undefined> = Object.fromEntries(process.argv.slice(3).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const input = process.argv[2];
if (!input || !args.name) {
  console.log('usage: node tools/nanite-model.ts <in.ply> --name=NAME [--tris=1000000] [--height=1] [--up=z]');
  process.exit(1);
}
const target = Number(args.tris ?? 1e6);
const t0 = performance.now();
const log = (s: string): void => console.log(`${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${s}`);

// ---------------------------------------------------------------- PLY
interface PlyProp {
  name: string;
  type: string;
  list?: boolean;
  count?: string; // (a list's length type)
}
interface PlyElement {
  name: string;
  count: number;
  props: PlyProp[];
}

function readPly(buf: Buffer): { pos: Float32Array; idx: Uint32Array } {
  const headEnd = buf.indexOf('end_header');
  const header = buf.subarray(0, headEnd).toString('latin1').split(/\r?\n/);
  let body = headEnd + 'end_header'.length;
  while (buf[body] !== 0x0a) body++;
  body++;
  const format = header.find((l) => l.startsWith('format'))?.split(' ')[1];
  const elements: PlyElement[] = [];
  for (const l of header) {
    const w = l.trim().split(/\s+/);
    if (w[0] === 'element') elements.push({ name: w[1], count: Number(w[2]), props: [] });
    else if (w[0] === 'property') elements.at(-1)?.props.push(w[1] === 'list' ? { list: true, count: w[2], type: w[3], name: w[4] } : { type: w[1], name: w[2] });
  }
  const size: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const le = format === 'binary_little_endian';
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const read = (t: string, o: number): number => {
    switch (t) {
      case 'char': case 'int8': return dv.getInt8(o);
      case 'uchar': case 'uint8': return dv.getUint8(o);
      case 'short': case 'int16': return dv.getInt16(o, le);
      case 'ushort': case 'uint16': return dv.getUint16(o, le);
      case 'int': case 'int32': return dv.getInt32(o, le);
      case 'uint': case 'uint32': return dv.getUint32(o, le);
      case 'float': case 'float32': return dv.getFloat32(o, le);
      default: return dv.getFloat64(o, le);
    }
  };
  let pos: Float32Array | null = null;
  if (format === 'ascii') {
    const idx: number[] = [];
    const lines = buf.subarray(body).toString('latin1').split(/\r?\n/);
    let li = 0;
    for (const el of elements) {
      if (el.name === 'vertex') {
        const xi = el.props.findIndex((p) => p.name === 'x');
        pos = new Float32Array(el.count * 3);
        for (let i = 0; i < el.count; i++) { const w = lines[li++].trim().split(/\s+/).map(Number); pos.set(w.slice(xi, xi + 3), i * 3); }
      } else if (el.name === 'face') {
        for (let i = 0; i < el.count; i++) { const w = lines[li++].trim().split(/\s+/).map(Number); for (let k = 2; k < w[0]; k++) idx.push(w[1], w[k], w[k + 1]); }
      } else li += el.count;
    }
    if (!pos) throw new Error('no vertices');
    return { pos, idx: Uint32Array.from(idx) };
  }
  let o = body, idx = new Uint32Array(0);
  for (const el of elements) {
    if (el.name === 'vertex') {
      pos = new Float32Array(el.count * 3);
      const offs: Record<string, { o: number; t: string }> = {}; let stride = 0;
      for (const p of el.props) { offs[p.name] = { o: stride, t: p.type }; stride += size[p.type]; }
      for (let i = 0; i < el.count; i++, o += stride) {
        pos[i * 3] = read(offs.x.t, o + offs.x.o); pos[i * 3 + 1] = read(offs.y.t, o + offs.y.o); pos[i * 3 + 2] = read(offs.z.t, o + offs.z.o);
      }
    } else if (el.name === 'face') {
      const out = new Uint32Array(el.count * 3);
      let n = 0, grow = out;
      for (let i = 0; i < el.count; i++) {
        for (const p of el.props) {
          if (!p.list) { o += size[p.type]; continue; }
          const ct = p.count ?? 'uchar';
          const c = read(ct, o); o += size[ct];
          const first = read(p.type, o), vs: number[] = [];
          for (let k = 0; k < c; k++) { vs.push(read(p.type, o)); o += size[p.type]; }
          if (p.name !== 'vertex_indices' && p.name !== 'vertex_index') continue;
          for (let k = 1; k + 1 < c; k++) {
            if (n + 3 > grow.length) { const g = new Uint32Array(grow.length * 2); g.set(grow); grow = g; }
            grow[n++] = first; grow[n++] = vs[k]; grow[n++] = vs[k + 1];
          }
        }
      }
      idx = grow.subarray(0, n);
    } else {
      throw new Error(`binary PLY element "${el.name}" before the faces isn't supported`);
    }
  }
  if (!pos) throw new Error('no vertices');
  return { pos, idx };
}

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
await MeshoptEncoder.ready;
let { pos, idx } = readPly(readFileSync(input));
log(`read ${input}: ${(pos.length / 3).toLocaleString()} vertices, ${(idx.length / 3).toLocaleString()} triangles`);

// stand it up: the up axis to +y (the longest extent unless --up), base at y = 0, centred in x and z, height 1
const ext = [0, 1, 2].map((k) => { let a = Infinity, b = -Infinity; for (let i = k; i < pos.length; i += 3) { a = Math.min(a, pos[i]); b = Math.max(b, pos[i]); } return [a, b]; });
const up: string = args.up ?? ['x', 'y', 'z'][[0, 1, 2].sort((a, b) => (ext[b][1] - ext[b][0]) - (ext[a][1] - ext[a][0]))[0]];
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
// drop unused vertices, order for the vertex cache and compression
const [remap, unique] = MeshoptEncoder.reorderMesh(idx, true, false);
const np = new Float32Array(unique * 3);
for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) np.set(pos.subarray(i * 3, i * 3 + 3), remap[i] * 3);
pos = np;
log(`${unique.toLocaleString()} vertices after reordering`);

// quantize to 16 bits over the bounding box
const lo = [0, 1, 2].map((k) => { let a = Infinity; for (let i = k; i < pos.length; i += 3) a = Math.min(a, pos[i]); return a; });
const hi = [0, 1, 2].map((k) => { let a = -Infinity; for (let i = k; i < pos.length; i += 3) a = Math.max(a, pos[i]); return a; });
const q = new Uint16Array(unique * 4);
for (let i = 0; i < unique; i++) for (let k = 0; k < 3; k++) q[i * 4 + k] = Math.round(((pos[i * 3 + k] - lo[k]) / (hi[k] - lo[k] || 1)) * 65535);
const vb = MeshoptEncoder.encodeVertexBuffer(new Uint8Array(q.buffer), unique, 8);

// the cluster DAG, built here from the very floats the site decodes (src/models.ts), at the height it's shown at
const { modelSource } = await import('../src/model-source.ts');
const { buildDag } = await import('../src/dag-build.ts');
const { dequantize, decodeModel } = await import('../src/models.ts');
const height = Number(args.height ?? 1);
const src = modelSource(dequantize(q, unique, lo, hi), idx, height);
const dag = await buildDag({ id: 0, bark: src.bark, leaves: src.leaves });
const clusters = dag.meta.length / 4;
log(`DAG at ${height} m: ${clusters.toLocaleString()} clusters, ${dag.stats.barkLevels + 1} levels, ${dag.stats.barkRoots} roots, ${dag.stats.ms} ms`);
const bytes = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const ib = MeshoptEncoder.encodeIndexBuffer(bytes(dag.idx), dag.idx.length, 4);
const rb = MeshoptEncoder.encodeVertexBuffer(bytes(dag.rec), clusters, 64);
const mb = MeshoptEncoder.encodeVertexBuffer(bytes(dag.meta), clusters, 16);
const head = Buffer.from(JSON.stringify({
  format: 'nanite-model 2', vertices: unique, lo, hi, height, vertexBytes: vb.length, indices: dag.idx.length, indexBytes: ib.length,
  clusters, recBytes: rb.length, metaBytes: mb.length, stats: dag.stats, source: args.source ?? '',
}));
const pad = (4 - (head.length % 4)) % 4;
const file = Buffer.concat([Buffer.from(new Uint32Array([head.length + pad]).buffer), head, Buffer.alloc(pad, 32), ...[vb, ib, rb, mb].map((b) => Buffer.from(b))]);
const outDir = join(root, 'public', 'models');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${args.name}.nm`);
writeFileSync(out, file);
log(`wrote ${out}: ${(file.length / 1e6).toFixed(2)} MB (positions ${(vb.length / 1e6).toFixed(2)}, DAG triangles ${(ib.length / 1e6).toFixed(2)}, clusters ${((rb.length + mb.length) / 1e6).toFixed(2)})`);

// read it back as the site does
const back = await decodeModel(new Uint8Array(file), height);
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
if (!same(canon(dag.idx), canon(back.dag.idx)) || !same(dag.rec, back.dag.rec) || !same(dag.meta, back.dag.meta) || dv > 1e-5 || turned > unique * 1e-4) {
  console.error(`round trip FAILED (largest position/uv difference ${dv}, ${turned} normals; same triangles ${same(canon(dag.idx), canon(back.dag.idx))}, records ${same(dag.rec, back.dag.rec)}, meta ${same(dag.meta, back.dag.meta)})`);
  process.exit(1);
}
log(`round trip ok`);
