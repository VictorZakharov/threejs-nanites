// Reads a PLY (binary either endianness, or ASCII; triangles or polygons): its vertex positions and triangles.

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

export function readPly(buf: Buffer): { pos: Float32Array; idx: Uint32Array } {
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
