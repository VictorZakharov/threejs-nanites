// Reads a glTF 2.0 (.gltf with its buffers in files or data: URIs, or .glb): every mesh of the default scene (or of
// every scene's root nodes without one), its node transforms applied, merged into one; materials, textures,
// skins and morph targets ignored. Positions of any component type (KHR_mesh_quantization) and meshopt-compressed
// buffer views (EXT/KHR_meshopt_compression) are read; Draco isn't (decode it first, e.g. gltf-transform's `copy`).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { MeshoptDecoder } from 'meshoptimizer';
import { MeshBuilder, type InputMesh } from './mesh.ts';

interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { children?: number[]; mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; extensions?: Record<string, unknown> }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string; sparse?: unknown }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, Meshopt> }[];
  buffers?: { uri?: string; byteLength: number }[];
  extensionsRequired?: string[];
}
interface Meshopt { buffer: number; byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string }

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export async function readGltf(buf: Buffer, path: string): Promise<InputMesh> {
  // a .glb: the JSON chunk, then the binary chunk (the buffer without a uri)
  let json: Gltf, bin: Uint8Array | null = null;
  if (buf.readUInt32LE(0) === 0x46546c67 /* glTF */) {
    const len = buf.readUInt32LE(12);
    json = JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) as Gltf;
    if (20 + len + 8 <= buf.length) bin = buf.subarray(28 + len, 28 + len + buf.readUInt32LE(20 + len));
  } else json = JSON.parse(buf.toString('utf8')) as Gltf;
  for (const e of json.extensionsRequired ?? []) {
    if (e === 'KHR_draco_mesh_compression') throw new Error('Draco-compressed glTF: decode it first (npx @gltf-transform/cli copy in.glb out.glb)');
    if (e === 'EXT_mesh_gpu_instancing') throw new Error('EXT_mesh_gpu_instancing isn\'t supported');
  }

  const buffers = (json.buffers ?? []).map((b, i): Uint8Array | null => {
    if (b.uri === undefined) return i === 0 ? bin : null; // (a meshopt fallback buffer may have no data at all)
    if (b.uri.startsWith('data:')) return Buffer.from(b.uri.slice(b.uri.indexOf(',') + 1), 'base64');
    return readFileSync(join(dirname(path), decodeURIComponent(b.uri)));
  });
  const views = new Map<number, { data: Uint8Array; stride?: number }>();
  const view = async (i: number): Promise<{ data: Uint8Array; stride?: number }> => {
    let v = views.get(i);
    if (v) return v;
    const bv = json.bufferViews![i];
    const mo = bv.extensions?.EXT_meshopt_compression ?? bv.extensions?.KHR_meshopt_compression;
    if (mo) {
      await MeshoptDecoder.ready;
      const src = buffers[mo.buffer]!.subarray(mo.byteOffset ?? 0, (mo.byteOffset ?? 0) + mo.byteLength);
      const data = new Uint8Array(mo.count * mo.byteStride);
      MeshoptDecoder.decodeGltfBuffer(data, mo.count, mo.byteStride, src, mo.mode, mo.filter);
      v = { data, stride: mo.byteStride };
    } else {
      const b = buffers[bv.buffer];
      if (!b) throw new Error(`buffer ${bv.buffer} has no data`);
      v = { data: b.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength), stride: bv.byteStride };
    }
    views.set(i, v);
    return v;
  };
  // an accessor's values as numbers (normalized integers mapped to -1..1 or 0..1)
  const accessor = async (i: number): Promise<{ values: Float64Array; size: number }> => {
    const a = json.accessors![i], size = COMPONENTS[a.type], bytes = BYTES[a.componentType];
    if (a.sparse) throw new Error(`accessor ${i} is sparse: not supported`);
    const values = new Float64Array(a.count * size);
    if (a.bufferView === undefined) return { values, size };
    const { data, stride } = await view(a.bufferView);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength), step = stride || size * bytes;
    for (let e = 0; e < a.count; e++) {
      for (let k = 0; k < size; k++) {
        const o = (a.byteOffset ?? 0) + e * step + k * bytes;
        let x: number;
        switch (a.componentType) {
          case 5120: x = dv.getInt8(o); if (a.normalized) x = Math.max(x / 127, -1); break;
          case 5121: x = dv.getUint8(o); if (a.normalized) x /= 255; break;
          case 5122: x = dv.getInt16(o, true); if (a.normalized) x = Math.max(x / 32767, -1); break;
          case 5123: x = dv.getUint16(o, true); if (a.normalized) x /= 65535; break;
          case 5125: x = dv.getUint32(o, true); break;
          default: x = dv.getFloat32(o, true);
        }
        values[e * size + k] = x;
      }
    }
    return { values, size };
  };

  const mesh = new MeshBuilder();
  const p = new Vector3();
  let skipped = 0;
  const visit = async (n: number, parent: Matrix4): Promise<void> => {
    const node = json.nodes![n];
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3().fromArray(node.translation ?? [0, 0, 0]), new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]), new Vector3().fromArray(node.scale ?? [1, 1, 1]));
    const world = parent.clone().multiply(local);
    if (node.mesh !== undefined) {
      const flip = world.determinant() < 0; // (a mirroring transform turns the triangles' winding round)
      for (const prim of json.meshes![node.mesh].primitives) {
        const mode = prim.mode ?? 4;
        if (mode < 4 || prim.attributes.POSITION === undefined) { skipped++; continue; } // (points and lines)
        const { values: pos } = await accessor(prim.attributes.POSITION);
        const first = mesh.vertices, count = pos.length / 3;
        for (let i = 0; i < count; i++) { p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(world); mesh.addVertex(p.x, p.y, p.z); }
        const idx = prim.indices !== undefined ? (await accessor(prim.indices)).values : Float64Array.from({ length: count }, (_, i) => i);
        const tri = (a: number, b: number, c: number): void => {
          if (flip) mesh.addTriangle(first + a, first + c, first + b); else mesh.addTriangle(first + a, first + b, first + c);
        };
        if (mode === 4) for (let t = 0; t + 2 < idx.length; t += 3) tri(idx[t], idx[t + 1], idx[t + 2]);
        else if (mode === 5) for (let t = 0; t + 2 < idx.length; t++) { if (t % 2) tri(idx[t + 1], idx[t], idx[t + 2]); else tri(idx[t], idx[t + 1], idx[t + 2]); }
        else for (let t = 1; t + 1 < idx.length; t++) tri(idx[0], idx[t], idx[t + 1]);
      }
    }
    for (const c of node.children ?? []) await visit(c, world);
  };
  const scenes = json.scene !== undefined ? [json.scenes![json.scene]] : json.scenes ?? [];
  const roots = scenes.flatMap((s) => s.nodes ?? []);
  // (no scenes at all: every node that isn't a child)
  if (!scenes.length) { const kids = new Set((json.nodes ?? []).flatMap((n) => n.children ?? [])); (json.nodes ?? []).forEach((_, i) => { if (!kids.has(i)) roots.push(i); }); }
  for (const r of roots) await visit(r, new Matrix4());
  if (skipped) console.log(`  (${skipped} primitives of points or lines skipped)`);
  return mesh.done();
}
