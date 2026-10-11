// Why drawn clusters that reach no pixel weren't culled (needs --query=ids=1, see the visible probe). Reads the
// clusters the main view drew (both phases' lists), which of them reach a pixel (debug 6 ids), and the depth pyramid
// (HZB level 0: each texel the max depth of 2x2 pixels, after the gap closing) with the camera it was built with.
// Each hidden cluster gets a perfect rectangle test on the CPU: its sphere's screen rect against every level 0 texel
// under it (the GPU test reads 4x4 texels of a coarser level), with and without the wind margin the GPU adds:
//   rectCull     hidden by the exact rect at half resolution, without the margin: a finer test would get it
//   marginOnly   only without the margin (the wind's reach: windMargin in constants.ts; 0 with wind=0)
//   inside       not even then: the sphere's rect shows something farther (gaps, sky, its own tree's parts)
// Also the triangles of each, and how many *seen* clusters the perfect test would cull (should be ~0).
import type { Demo } from '../../src/harness-api.ts';
import type { Vector4 } from 'three';

async (demo: Demo) => {
  const f = demo.forest, r = demo.renderer, rt = demo.sceneRT, L = f.ctrLayout, h = f.hzb;
  f.u.debug.value = 6;
  await demo.renderOnce();
  type Attr = Parameters<typeof r.getArrayBufferAsync>[0];
  const u32 = async (attr: Attr): Promise<Uint32Array> => new Uint32Array(await r.getArrayBufferAsync(attr));
  const f32 = async (attr: Attr): Promise<Float32Array> => new Float32Array(await r.getArrayBufferAsync(attr));
  const [ctr, hzb, ids] = [await u32(f.main.ctr.attr), await f32(h.buf.value), await r.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height, 1)];
  const lists: Uint32Array[] = [];
  for (const set of f.main.sets) lists.push(await u32(set.listAttr));
  f.u.debug.value = 0;
  const half = (v: number): number => {
    const e = (v >> 10) & 31, m = v & 1023;
    return e === 0 ? m / 16777216 : (1 + m / 1024) * 2 ** (e - 15);
  };
  const get = ids instanceof Uint16Array ? (i: number) => half(ids[i]) : (i: number) => ids[i];
  const seen = new Set<number>();
  for (let p = 0; p < rt.width * rt.height; p++) {
    const a = Math.round(get(p * 4 + 3));
    if (a >= 1) seen.add((Math.round(get(p * 4)) + Math.round(get(p * 4 + 1)) * 2048) * 65536 + Math.round(get(p * 4 + 2)) + (a - 1) * 2048);
  }
  const inst = f.inst.value.array, cd = f.cData.value.array, meta = new Uint32Array(cd.buffer, cd.byteOffset, cd.length);
  const ti = f.typeInfo.array as Vector4[], windOf = f.windOf.array as number[];
  const [off, w, hh] = [h.levelValues[0].x, h.levelValues[0].y, h.levelValues[0].z];
  const [W, H] = [h.size.value.x, h.size.value.y], V = h.view.value.elements, P = h.proj.value, near = h.near.value;
  const cam = demo.camera.position, R2 = 2 * L.PLANET_RADIUS;
  // the GPU's test (hzb.ts _hzbOccluded) with an exact rect: true if hidden
  const hidden = (x: number, y: number, z: number, rad: number): boolean => {
    const cx = V[0] * x + V[4] * y + V[8] * z + V[12], cy = V[1] * x + V[5] * y + V[9] * z + V[13], cz = V[2] * x + V[6] * y + V[10] * z + V[14];
    const d = -cz, d0 = d - rad, d1 = d + rad;
    if (d0 <= near) return false;
    const ext = (lo: number, hi: number, k: number): [number, number] => {
      const q = [lo / d0, lo / d1, hi / d0, hi / d1];
      return [Math.max(-1, Math.min(1, Math.min(...q) * k)), Math.max(-1, Math.min(1, Math.max(...q) * k))];
    };
    const [nx0, nx1] = ext(cx - rad, cx + rad, P.x), [ny0, ny1] = ext(cy - rad, cy + rad, P.y);
    const px0 = (nx0 * 0.5 + 0.5) * W, px1 = (nx1 * 0.5 + 0.5) * W, py0 = (-ny1 * 0.5 + 0.5) * H, py1 = (-ny0 * 0.5 + 0.5) * H;
    const t = (p: number, n: number): number => Math.min(Math.max(Math.floor(p / 2), 0), n - 1);
    let far = 0;
    for (let ty = t(py0, hh); ty <= t(py1, hh); ty++) for (let tx = t(px0, w); tx <= t(px1, w); tx++) far = Math.max(far, hzb[off + ty * w + tx]);
    return (P.z * -d0 + P.w) / d0 > far;
  };
  const out = { drawn: 0, seen: 0, rectCull: 0, marginOnly: 0, inside: 0, seenWouldCull: 0, tris: { seen: 0, rectCull: 0, marginOnly: 0, inside: 0 } };
  type Kind = 'rectCull' | 'marginOnly' | 'inside';
  f.main.sets.forEach((set, k) => {
    const list = lists[k];
    for (const [arg, base] of [[L.ARGS.bark, 0], [L.ARGS.leaf, L.LIST_CAP]]) {
      const n = Math.min(ctr[set.base + arg + 1], L.LIST_CAP);
      for (let e = 0; e < n; e++) {
        const i = list[(base + e) * 2], c = list[(base + e) * 2 + 1];
        const a = i * 8, o = c * 20, s = inst[a + 3], cs = inst[a + 4], sn = inst[a + 5];
        const lx = cd[o + 8], ly = cd[o + 9], lz = cd[o + 10];
        const x = inst[a] + (lx * cs - lz * sn) * s, z = inst[a + 2] + (lx * sn + lz * cs) * s;
        const y = inst[a + 1] + ly * s - ((x - cam.x) ** 2 + (z - cam.z) ** 2) / R2;
        // (windMargin in constants.ts: the bend up to the sphere's top, and the leaves' flutter)
        const H = ti[inst[a + 6]].w, top = Math.min(1, Math.max(0, (cd[o + 9] + cd[o + 11]) / H));
        const rad = cd[o + 11] * s, margin = (top * top * H * 0.0728 + 0.0528) * s * f.u.wind.value * windOf[inst[a + 6]];
        const tris = meta[o + 17];
        out.drawn++;
        if (seen.has(i * 65536 + c)) {
          out.seen++;
          out.tris.seen += tris;
          if (hidden(x, y, z, rad)) out.seenWouldCull++;
          continue;
        }
        const kind: Kind = hidden(x, y, z, rad + margin) ? 'rectCull' : hidden(x, y, z, rad) ? 'marginOnly' : 'inside';
        out[kind]++;
        out.tris[kind] += tris;
      }
    }
  });
  await demo.renderOnce();
  return out;
}
