// Reads a Wavefront OBJ: every object and group's faces (polygons as fans) merged into one mesh, by their `v`
// positions; texture coordinates, normals, materials, lines and points ignored.
import { MeshBuilder, type InputMesh } from './mesh.ts';

export async function readObj(buf: Buffer): Promise<InputMesh> {
  const mesh = new MeshBuilder();
  const face: number[] = [];
  // (line by line through the buffer: a big scan's text is more than one string can hold)
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    const c0 = buf[start], c1 = buf[start + 1];
    if ((c0 === 0x76 /* v */ || c0 === 0x66 /* f */) && (c1 === 0x20 || c1 === 0x09)) {
      const w = buf.subarray(start + 2, end).toString('latin1').trim().split(/\s+/);
      if (c0 === 0x76) mesh.addVertex(Number(w[0]), Number(w[1]), Number(w[2]));
      else {
        face.length = 0;
        // v, v/vt, v//vn or v/vt/vn; negative indices count back from the last vertex read
        for (const s of w) {
          const v = parseInt(s, 10), i = v < 0 ? mesh.vertices + v : v - 1;
          if (!(i >= 0 && i < mesh.vertices)) throw new Error(`face index ${s} out of range (${mesh.vertices} vertices so far)`);
          face.push(i);
        }
        for (let k = 1; k + 1 < face.length; k++) mesh.addTriangle(face[0], face[k], face[k + 1]);
      }
    }
    start = end + 1;
  }
  return mesh.done();
}
