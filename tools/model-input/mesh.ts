// What the readers return, and the pieces the glTF and OBJ readers share.
import { MeshoptSimplifier } from 'meshoptimizer';

export interface InputMesh {
  pos: Float32Array;
  idx: Uint32Array;
}

/** Growing arrays of positions and triangles: the meshes of a file merged into one as they're read. */
export class MeshBuilder {
  pos = new Float32Array(1 << 12);
  idx = new Uint32Array(1 << 12);
  vertices = 0;
  indices = 0;

  addVertex(x: number, y: number, z: number): void {
    if (this.vertices * 3 + 3 > this.pos.length) { const g = new Float32Array(this.pos.length * 2); g.set(this.pos); this.pos = g; }
    this.pos[this.vertices * 3] = x; this.pos[this.vertices * 3 + 1] = y; this.pos[this.vertices * 3 + 2] = z;
    this.vertices++;
  }

  addTriangle(a: number, b: number, c: number): void {
    if (a === b || b === c || a === c) return;
    if (this.indices + 3 > this.idx.length) { const g = new Uint32Array(this.idx.length * 2); g.set(this.idx); this.idx = g; }
    this.idx[this.indices++] = a; this.idx[this.indices++] = b; this.idx[this.indices++] = c;
  }

  /** The merged mesh, with vertices at the same position welded into one (glTF and OBJ split them at uv and normal
   *  seams, and between meshes: the simplifier would open those up as cracks). */
  async done(): Promise<InputMesh> {
    if (!this.indices) throw new Error('no triangles');
    await MeshoptSimplifier.ready;
    const pos = this.pos.slice(0, this.vertices * 3), idx = this.idx.slice(0, this.indices);
    const remap = MeshoptSimplifier.generatePositionRemap(pos, 3);
    // only the vertices a triangle uses (an OBJ's lines and points, say, would count in the extents the model is
    // stood up by), numbered in order of first use
    const used = new Uint32Array(this.vertices).fill(0xffffffff);
    const out = new MeshBuilder();
    out.idx = new Uint32Array(idx.length);
    const vertex = (i: number): number => {
      const w = remap[i];
      if (used[w] === 0xffffffff) { used[w] = out.vertices; out.addVertex(pos[w * 3], pos[w * 3 + 1], pos[w * 3 + 2]); }
      return used[w];
    };
    for (let t = 0; t < idx.length; t += 3) out.addTriangle(vertex(idx[t]), vertex(idx[t + 1]), vertex(idx[t + 2]));
    return { pos: out.pos.slice(0, out.vertices * 3), idx: out.idx.subarray(0, out.indices) };
  }
}
