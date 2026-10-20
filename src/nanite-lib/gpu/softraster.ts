// Software rasterizer + visibility buffer, Nanite-style, for clusters whose triangles are tiny on screen.
//
// The hardware rasterizer shades pixels in 2x2 quads and is slow on triangles of about a pixel, which is what a
// distant tree's clusters are made of (128 triangles over a few pixels). The main view's cluster pass sends a
// cluster whose triangles average under `swArea` pixels (?swarea=, default 4) to a separate list (`wants` /
// `append`) instead of the indirect draws, and that list is rasterized here, in compute:
//   1. clear    the visibility buffer: per pixel a depth word and an id word
//   2. depth    one thread per triangle walks the pixel centres in its screen box: atomicMin of the view depth
//   3. id       the same walk again; where its depth won: atomicMax of (list slot, triangle) + 1
//               (WebGPU has no 64-bit atomics for depth + id in one step; max keeps equal-depth ties stable)
//   4. resolve  a fullscreen quad, drawn with the phase 2 meshes: per pixel it reads the id, rebuilds the triangle
//               and its barycentrics, and shades it with a three.js Lambert material whose normal, shadow position
//               and depth are overridden, so lights, shadows and fog are the hardware path's. It writes the depth,
//               so it composites with the hardware-drawn geometry by the ordinary depth test.
// Leaves are alpha-tested in the walk (explicit mip from the triangle's texel/pixel ratio, coverage-preserving
// scale), and the impostor cross-fade dither is applied there too. One sample per pixel: no MSAA on these pixels.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Discard, storage, uniform, uint, int, float, vec2, vec3, vec4, uvec2, min, max, abs, clamp, log2,
  select, smoothstep, atomicAdd, atomicMin, atomicMax, atomicLoad, atomicStore, floatBitsToUint, workgroupId, localId,
  numWorkgroups, instanceIndex, screenCoordinate, texture, positionGeometry, output, mix, cameraViewMatrix, normalize,
  length,
} from 'three/tsl';
import type { ComputeNode, StorageBufferNode } from 'three/webgpu';
import { LIST_CAP, MAX_TRIS, PHASE2_LAYER, SW, SPLAT_BIT, minU, minI, maxI } from './constants.ts';
import type { NaniteRenderer } from './renderer.ts';
import type { Bool, Float, Int, Uint, Vec2, Vec3 } from '../types.ts';
import type { ClusterVertex, Counters, Shading, U } from './types.ts';
import { setEmissive, asReceivedShadow, floatBits, computeBatch } from '../three-gaps.ts';
import { makeLeafAlphaLod, ditherAt, ditherAlt, LEAF_COV, LEAF_DITHER, mipBias } from './shading.ts';

/** Visibility buffer capacity (pixels of the drawing buffer); a bigger screen falls back to hardware only. */
export const MAX_PIXELS = 3840 * 2160;
const MAX_BOX = 48; // a triangle walks at most this many pixels a side (the classification keeps them far smaller)
const EMPTY = 0xffffffff;
/** Debug 5 colour of the software rasterizer's pixels. */
const SW_DEBUG = vec3(1, 0.45, 0);

/** Edge function of p against a -> b (twice the signed area of a, b, p; y down). */
const edge = (a: Vec2, b: Vec2, p: Vec2): Float => b.x.sub(a.x).mul(p.y.sub(a.y)).sub(b.y.sub(a.y).mul(p.x.sub(a.x)));

/** A triangle on screen (see _triangle). */
interface ScreenTriangle {
  V: ClusterVertex[];
  P: Vec2[];
  W: Float[];
  area: Float;
}
type Slopes = { dx: Vec2; dy: Vec2 };

export class SoftRaster {
  readonly nanite: NaniteRenderer;
  readonly on = uniform(1, 'uint'); // u.sw, and the screen fits the visibility buffer
  readonly size = uniform(new THREE.Vector2(1, 1)); // drawing buffer pixels
  readonly viewProj = uniform(new THREE.Matrix4());
  readonly near = uniform(0.3);
  readonly listAttr = new THREE.StorageBufferAttribute(new Uint32Array(LIST_CAP * 2), 2);
  // (its counts: clusters, triangles (appended), clusters (clamped), in the main view's counters at SW)
  readonly ctr: Counters;
  readonly dispatchAttr = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4);
  readonly depthAttr = new THREE.StorageBufferAttribute(new Uint32Array(MAX_PIXELS), 1);
  /**
   * Off for now (set per frame by the application: the demo's SW_ALTITUDE): near the ground it doesn't pay. It costs ~0.36 ms a frame
   * whatever it takes (clear, two walks, the resolve) and redoes each triangle's vertices twice; the far trees it's
   * for are mostly hidden down there (on High at 1080p: 0.3-0.4 ms slower on the ground, 0.4-0.8 faster from 45 m up).
   */
  idle = false;
  resolveMesh: THREE.Mesh | null = null;
  readonly idAttr = new THREE.StorageBufferAttribute(new Uint32Array(MAX_PIXELS), 1);
  readonly wants: (cw: Vec3, rad: Float, tris: Uint) => Bool;
  readonly append: (inst: Uint, c: Uint, tris: Uint) => void;
  readonly reset: ComputeNode;
  readonly args: ComputeNode;
  readonly clear: ComputeNode;
  readonly leafAlpha: (a: Float, layer: Float, lod: Float) => Float;
  readonly depthPass: ComputeNode;
  readonly idPass: ComputeNode;
  ran = false;

  constructor(nanite: NaniteRenderer) {
    this.nanite = nanite;
    const u = nanite.u;
    const sw: U<'uint', number> = uniform(Number(new URLSearchParams(location.search).get('sw') ?? 1), 'uint'); // on/off (?sw=0)
    const swArea = uniform(Number(new URLSearchParams(location.search).get('swarea') ?? 4)); // see wants()
    u.sw = sw;
    u.swArea = swArea;
    const ctr = nanite.mainCtr;
    this.ctr = ctr;

    const list = storage(this.listAttr, 'uvec2', LIST_CAP);
    /** True if a cluster (curved centre cw, radius rad) is small enough on screen for the software rasterizer. */
    /**
     * True if a cluster (curved centre cw, radius rad, `tris` triangles) is for the software rasterizer: its
     * triangles average under `swArea` pixels (its projected disc over its triangle count), it spans less than a
     * triangle walk's box, and it's well clear of the near plane (the walk doesn't clip).
     */
    this.wants = (cw, rad, tris) => {
      const d = length(cw.sub(u.camPos));
      const rPx = rad.mul(u.projScale).div(d);
      return this.on.equal(1)
        .and(rPx.mul(rPx).mul(Math.PI).lessThan(swArea.mul(float(tris))))
        .and(rPx.lessThan(MAX_BOX / 2))
        .and(d.sub(rad).greaterThan(this.near.mul(4)));
    };
    this.append = (inst, c, tris) => {
      const slot = atomicAdd(ctr.atomic.element(SW), uint(1)).toVar();
      atomicAdd(ctr.atomic.element(SW + 1), tris);
      If(slot.lessThan(LIST_CAP), () => list.element(slot).assign(uvec2(inst, c)));
    };
    this.reset = Fn(() => {
      atomicStore(ctr.atomic.element(SW), uint(0));
      atomicStore(ctr.atomic.element(SW + 1), uint(0));
    })().compute(1, [1]);

    // the cluster count as a 2D dispatch (65535 workgroups per dimension), one workgroup per cluster
    const count = (i: number) => ctr.rw.element(SW + i);
    const disp = storage(this.dispatchAttr, 'uint', 4);
    this.args = Fn(() => {
      const n = minU(count(0), LIST_CAP).toVar();
      count(2).assign(n);
      disp.element(0).assign(minU(n, 65535));
      disp.element(1).assign(n.add(65534).div(65535));
    })().compute(1, [1]);

    const depthW = storage(this.depthAttr, 'uint', MAX_PIXELS), idW = storage(this.idAttr, 'uint', MAX_PIXELS);
    this.clear = Fn(() => {
      const i = instanceIndex;
      If(i.lessThan(uint(this.size.x).mul(uint(this.size.y))), () => {
        depthW.element(i).assign(uint(EMPTY));
        idW.element(i).assign(uint(0));
      });
    })().compute(MAX_PIXELS, [64]);

    this.leafAlpha = makeLeafAlphaLod(nanite.textures.leaf);
    this.depthPass = this._rasterPass('depth');
    this.idPass = this._rasterPass('id');
  }

  /**
   * Triangle `tri` of cluster c of tree inst on screen: per corner the vertex (world position, normal, uv), its
   * pixel position (y down) and clip w (= view depth); `area` is twice the signed screen area.
   */
  _triangle(inst: Uint, c: Uint, tri: Uint, leaf: Bool): ScreenTriangle {
    const V: ClusterVertex[] = [], P: Vec2[] = [], W: Float[] = [];
    for (let j = 0; j < 3; j++) {
      const vx = this.nanite._vertex(inst, c, tri.mul(3).add(j), leaf);
      const clip = this.viewProj.mul(vec4(vx.world, 1)).toVar();
      const sx = clip.x.div(clip.w).mul(0.5).add(0.5).mul(this.size.x);
      const sy = clip.y.div(clip.w).mul(-0.5).add(0.5).mul(this.size.y);
      V.push(vx);
      P.push(vec2(sx, sy).toVar());
      W.push(clip.w);
    }
    return { V, P, W, area: edge(P[0], P[1], P[2]).toVar() };
  }

  /** Perspective-correct barycentric weights of pixel point p (they sum to 1), and the view depth there. */
  _weights(t: ScreenTriangle, p: Vec2): { b: Float[]; q: Float[]; depth: Float } {
    const b = [edge(t.P[1], t.P[2], p), edge(t.P[2], t.P[0], p), edge(t.P[0], t.P[1], p)].map((e) => e.div(t.area));
    const q = b.map((bi, j) => bi.div(t.W[j]));
    const sum = q[0].add(q[1]).add(q[2]);
    return { b, q: q.map((qi) => qi.div(sum)), depth: float(1).div(sum) };
  }

  /** The uv change per pixel step in x and in y over this triangle (affine: its triangles are tiny). */
  _uvSlopes(t: ScreenTriangle): Slopes {
    const { P, V } = t;
    // d(barycentric j)/dx and /dy, from the edge opposite corner j
    const db = [[P[1], P[2]], [P[2], P[0]], [P[0], P[1]]].map(([a, b]) => [a.y.sub(b.y).div(t.area), b.x.sub(a.x).div(t.area)]);
    const dx = V[0].uv.mul(db[0][0]).add(V[1].uv.mul(db[1][0])).add(V[2].uv.mul(db[2][0])).toVar();
    const dy = V[0].uv.mul(db[0][1]).add(V[1].uv.mul(db[1][1])).add(V[2].uv.mul(db[2][1])).toVar();
    return { dx, dy };
  }

  /** Mip level for a texture of `size` texels (as the hardware leaves pick it: the larger of the two uv slopes). */
  _lod(slopes: Slopes, size: number): Float {
    return log2(max(max(length(slopes.dx), length(slopes.dy)).mul(size), 1e-6)).add(mipBias); // (for the output's pixels)
  }

  _rasterPass(mode: 'depth' | 'id'): ComputeNode {
    const f = this.nanite;
    const list = storage(this.listAttr, 'uvec2', LIST_CAP).toReadOnly();

    const depthA = storage(this.depthAttr, 'uint', MAX_PIXELS).toAtomic();
    const idA = storage(this.idAttr, 'uint', MAX_PIXELS).toAtomic();
    const tex = f.textures;
    return Fn(() => {
      const slot = workgroupId.x.add(workgroupId.y.mul(numWorkgroups.x)).toVar();
      const tri = localId.x;
      If(slot.lessThan(this.ctr.ro.element(SW + 2)), () => {
        const e = list.element(slot);
        const inst = e.x.toVar(), c = e.y.toVar();
        If(tri.lessThan(f._meta(c).y), () => {
          const leaf = f._cd(c, 3).w.greaterThanEqual(0.5).toVar();
          const t = this._triangle(inst, c, tri, leaf);
          // bark is single-sided (front = counter-clockwise in NDC = negative area with y down); leaves aren't
          const facing = leaf.or(t.area.lessThan(0));
          const inFront = t.W[0].greaterThan(this.near).and(t.W[1].greaterThan(this.near)).and(t.W[2].greaterThan(this.near));
          If(facing.and(inFront).and(abs(t.area).greaterThan(1e-8)), () => {
            const W = int(this.size.x), H = int(this.size.y);
            const lo = min(min(t.P[0], t.P[1]), t.P[2]), hi = max(max(t.P[0], t.P[1]), t.P[2]);
            // pixel centres (x + 0.5) inside the box
            const x0 = maxI(int(lo.x.sub(0.5).ceil()), int(0)).toVar(), y0 = maxI(int(lo.y.sub(0.5).ceil()), int(0)).toVar();
            const x1 = minI(minI(int(hi.x.sub(0.5).floor()), W.sub(1)), x0.add(MAX_BOX - 1)).toVar();
            const y1 = minI(minI(int(hi.y.sub(0.5).floor()), H.sub(1)), y0.add(MAX_BOX - 1)).toVar();
            const fade = f._geometryShare(inst).toVar();
            const layer = tex.leafLayerOf(f._b(inst).z.toUint()).toVar();
            const slopes = this._uvSlopes(t);
            const lod = this._lod(slopes, tex.leaf.image.width).toVar();
            const id = slot.mul(MAX_TRIS).add(tri).add(1);
            // (rows i, columns j: one Loop with two ranges, so the two counters get distinct names)
            const rows = { start: y0, end: y1, type: 'int', condition: '<=' } as const;
            const cols = { start: x0, end: x1, type: 'int', condition: '<=' } as const;
            Loop(rows, cols, ({ i: py, j: px }) => {
              {
                const p = vec2(float(px).add(0.5), float(py).add(0.5));
                const w = this._weights(t, p);
                const inside = w.b[0].greaterThanEqual(0).and(w.b[1].greaterThanEqual(0)).and(w.b[2].greaterThanEqual(0)).toVar();
                // (the id pass skips the cut-out tests: its depth matching the winner's means it passed them)
                if (mode === 'depth') inside.assign(inside.and(ditherAt(p).lessThan(fade))); // (impostor cross-fade, as in the hardware draw)
                if (mode === 'depth') If(inside.and(leaf), () => {
                  const uv = t.V[0].uv.mul(w.q[0]).add(t.V[1].uv.mul(w.q[1])).add(t.V[2].uv.mul(w.q[2]));
                  const alphaAt = (q: Vec2): Float => this.leafAlpha(texture(tex.leaf, q).depth(layer).level(lod).a, layer, lod);
                  // as three.js does alpha to coverage on the hardware leaves: coverage = an antialiased alpha test,
                  // smoothstep(0.5, 0.5 + fwidth(alpha), alpha), over the pixel's samples; here one sample, so it's
                  // covered if that beats a fixed per-pixel threshold (fwidth from the neighbouring pixels' uv)
                  let coverage: Float;
                  if (LEAF_DITHER) {
                    // the plain filtered alpha is the share of the pixel the leaves cover: drawn with that
                    // probability (the dither moves every frame and TAA averages it), not sharpened into a cut-out
                    // that makes each distant crown a hard speckle shimmering as it moves
                    coverage = texture(tex.leaf, uv).depth(layer).level(lod).a.mul(LEAF_COV);
                  } else {
                    const alpha = alphaAt(uv).toVar();
                    const fw = abs(alphaAt(uv.add(slopes.dx)).sub(alpha)).add(abs(alphaAt(uv.add(slopes.dy)).sub(alpha)));
                    coverage = smoothstep(0.5, max(fw, 1e-4).add(0.5), alpha);
                  }
                  inside.assign(coverage.greaterThan(ditherAlt(p)));
                });
                If(inside, () => {
                  const pix = uint(py).mul(uint(W)).add(uint(px));
                  const z = floatBits(w.depth, floatBitsToUint); // (positive floats order like their bits)
                  if (mode === 'depth') atomicMin(depthA.element(pix), z);
                  else If(atomicLoad(depthA.element(pix)).equal(z), () => atomicMax(idA.element(pix), id));
                });
              }
            });
          });
        });
      });
    })().compute(LIST_CAP * MAX_TRIS, [MAX_TRIS]);
  }

  /** Per frame, before the phase 2 render: rasterize this frame's list (after the occlusion pass appended to it). */
  rasterize(renderer: THREE.WebGPURenderer, camera: THREE.Camera, width: number, height: number): void {
    if (!this.ran || this.on.value === 0) return;
    const r = renderer;
    this.viewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // (and the splatted impostors, splats.ts: every depth before any id)
    const sp = this.nanite.splats;
    const splat = (pass: ComputeNode | null): [ComputeNode, THREE.IndirectStorageBufferAttribute][] => (pass && sp.on.value === 1 ? [[pass, sp.dispatchAttr]] : []);
    computeBatch(r, [
      this.args, ...(sp.args && sp.on.value === 1 ? [sp.args] : []), [this.clear, width * height],
      [this.depthPass, this.dispatchAttr], ...splat(sp.depthPass), [this.idPass, this.dispatchAttr], ...splat(sp.idPass),
    ]);
  }

  /** Called before culling: screen size, camera near plane; resets the list. */
  begin(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera, width: number, height: number): void {
    this.size.value.set(width, height);
    this.near.value = camera.near;
    this.on.value = this.nanite.u.sw?.value === 1 && !this.idle && width * height <= MAX_PIXELS ? 1 : 0;
    if (this.resolveMesh) this.resolveMesh.visible = this.on.value === 1; // (not even a fullscreen pass of discards)
    renderer.compute(this.reset);
    this.ran = true;
  }

  /**
   * The fullscreen resolve quad (phase 2 layer). `shading`: { fadeShadow(pos) => receivedShadowNode, fog(pos, viewZ)
   * => { color, factor } } from the application (the demo's lighting.ts), so shadows and fog match the hardware draws.
   */
  buildResolveMesh(shading: Shading): THREE.Mesh {
    const f = this.nanite, u = f.u, tex = f.textures;
    const ids = storage(this.idAttr, 'uint', MAX_PIXELS).toReadOnly();
    const list = storage(this.listAttr, 'uvec2', LIST_CAP).toReadOnly();
    const pix = uvec2(screenCoordinate.xy);
    const id = ids.element(pix.y.mul(uint(this.size.x)).add(pix.x));
    // (debug 5: magenta where the depth pass covered the pixel but the id pass found no triangle at that depth)
    const depths = storage(this.depthAttr, 'uint', MAX_PIXELS).toReadOnly();
    const lost = id.equal(0).and(depths.element(pix.y.mul(uint(this.size.x)).add(pix.x)).notEqual(uint(EMPTY))).and(u.debug.equal(5));
    const e = id.sub(1);
    const entry = list.element(e.shiftRight(7));
    const inst = entry.x, c = entry.y;
    const tri = e.bitAnd(MAX_TRIS - 1);
    const leaf = f._cd(c, 3).w.greaterThanEqual(0.5);
    const t = this._triangle(inst, c, tri, leaf);
    const w = this._weights(t, screenCoordinate.xy);
    const lerp3 = (k: 'world' | 'normal'): Vec3 => t.V[0][k].mul(w.q[0]).add(t.V[1][k].mul(w.q[1])).add(t.V[2][k].mul(w.q[2]));
    const world = lerp3('world');
    const uv = t.V[0].uv.mul(w.q[0]).add(t.V[1].uv.mul(w.q[1])).add(t.V[2].uv.mul(w.q[2]));
    const normal = normalize(lerp3('normal'));
    const type = t.V[0].type;
    const slopes = this._uvSlopes(t);
    const bark = texture(tex.bark, uv).depth(tex.barkLayerOf(type)).level(this._lod(slopes, tex.bark.image.width)).rgb;
    const leafLayer = tex.leafLayerOf(type);
    const leafRgb = texture(tex.leaf, uv).depth(leafLayer).level(this._lod(slopes, tex.leaf.image.width)).rgb;
    const albedo = select(leaf, f.look.cardColour(leafRgb, leafLayer, f.look.tint(inst), f.look.cardValue(inst, f._b(inst))), f.look.solidColour(bark));
    const dbg = f._debugColour(inst, c, type);

    const mat = new THREE.MeshLambertNodeMaterial();
    mat.vertexNode = vec4(positionGeometry.xy, 0, 1);
    mat.fog = false;
    mat.colorNode = Fn(() => {
      Discard(id.equal(0).and(lost.not()).or(this.on.equal(0)).or(id.greaterThanEqual(uint(SPLAT_BIT)))); // (splats: splats.ts)
      return vec4(select(lost, vec3(1, 0, 1), select(u.debug.equal(5), SW_DEBUG, select(u.debug.equal(4), vec3(0), select(u.debug.greaterThan(0), dbg, albedo)))), 1);
    })();
    mat.normalNode = normalize(cameraViewMatrix.mul(vec4(normal, 0)).xyz);
    // (leaves: light passing through, as on the hardware-drawn leaves)
    setEmissive(mat, select(lost, vec3(1, 0, 1), select(u.debug.equal(5), SW_DEBUG, select(u.debug.equal(4), dbg, select(u.debug.greaterThan(0).or(leaf.not()), vec3(0), albedo.mul(0.12))))));
    mat.receivedShadowPositionNode = world;
    mat.receivedShadowNode = asReceivedShadow(shading.fadeShadow(world));
    const clip = this.viewProj.mul(vec4(world, 1));
    mat.depthNode = clip.z.div(clip.w);
    const fog = shading.fog(world, w.depth);
    mat.outputNode = vec4(mix(output.rgb, fog.color, fog.factor), output.a);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mesh = (this.resolveMesh = new THREE.Mesh(geo, mat));
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.layers.set(PHASE2_LAYER);
    mesh.name = 'nanite-software-resolve';
    return mesh;
  }

  /** Clusters and triangles in this frame's list (async readback, for the HUD / harness). */
  async readStats(renderer: THREE.WebGPURenderer): Promise<{ swClusters: number; swTris: number }> {
    if (!this.ran) return { swClusters: 0, swTris: 0 };
    const c = new Uint32Array(await renderer.getArrayBufferAsync(this.ctr.attr));
    return { swClusters: c[SW], swTris: c[SW + 1] };
  }
}
