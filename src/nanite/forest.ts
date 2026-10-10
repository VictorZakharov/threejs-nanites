// GPU-driven cluster LOD renderer ("nanite") for the forest.
//
// Per frame, entirely on the GPU (no readback):
//   1. reset      zero the indirect dispatch/draw counters
//   2. instances  one thread per tree: frustum + distance cull, then from its distance work out how many of its
//                 clusters could possibly be selected (clusters are sorted by parent error, so it's a prefix found by
//                 binary search) and emit 64-cluster work items for them
//   3. clusters   (indirect dispatch) one thread per candidate cluster: DAG cut test
//                 (own projected error <= threshold < parent projected error) + frustum cull, append to bark/leaf list
//   4. draw       two indirect draws (bark, leaves); each draw instance is one cluster, the vertex shader pulls its
//                 triangles from storage buffers (128 tris max, the rest degenerate). In the main view, clusters of
//                 tiny triangles go to the software rasterizer instead (src/nanite/softraster.js).
// Steps 1-3 run twice: for the camera, and for the sun's shadow map (its own frustum, coarser LOD). The shadow
// meshes live on layer 1, which only the shadow camera sees.
import * as THREE from 'three/webgpu';
import { storage, uniform, uniformArray, bitcast } from 'three/tsl';
import type { StorageBufferNode, UniformArrayNode } from 'three/webgpu';
import { SoftRaster } from './softraster.ts';
import { SHADOW_TAU_MUL, PHASE2_LAYER, CD_STRIDE, makeCounters, ARGS, STATS, ITEM_COUNT, RETEST, SW } from './constants.ts';
import { cullingMethods } from './culling.ts';
import { hzbMethods } from './hzb.ts';
import { drawMethods } from './draw.ts';
import { billboardMethods } from './billboards.ts';
import type { BuiltTree } from '../trees.ts';
import type { TreeInstances } from '../placement.ts';
import type { Uint, UVec4 } from '../types.ts';
import type { Counters, ForestStats, ForestTextures, ForestUniforms, View } from './types.ts';
import type { Hzb } from './hzb.ts';

type TypeStats = BuiltTree['stats'] & { name: string; radius: number };

// The stage modules' methods, attached to the prototype at the end of this file.
export interface NaniteForest
  extends Omit<typeof cullingMethods, never>, Omit<typeof hzbMethods, never>, Omit<typeof drawMethods, never>, Omit<typeof billboardMethods, never> {}

function countFlags(buf: ArrayBuffer): number {
  const f = new Uint32Array(buf);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i];
  return n;
}

export class NaniteForest {
  readonly renderer: THREE.WebGPURenderer;
  frozen = false;
  readonly u: ForestUniforms;
  readonly textures: ForestTextures;
  // GPU data (see _buildBuffers and the accessors)
  vtx!: StorageBufferNode<'vec4'>;
  idx!: StorageBufferNode<'uint'>;
  cData!: StorageBufferNode<'vec4'>;
  inst!: StorageBufferNode<'vec4'>;
  typeInfo!: UniformArrayNode<'vec4'>;
  instanceCount = 0;
  treeCount = 0; // (of instanceCount: the rest are bushes)
  stats!: { clusters: number; verts: number; tris: number; types: TypeStats[] };
  hzb!: Hzb;
  hzbReady = false;
  /** The impostors' colour gains per tree type (live uniforms: harness --typematch=calibrate adjusts them). */
  impGains: { side: UniformArrayNode<'vec3'>; top: UniformArrayNode<'vec3'> } | null = null;
  readonly mainCtr: Counters;
  readonly ctrLayout: { ARGS: typeof ARGS; STATS: number; ITEM_COUNT: number; RETEST: number; SW: number };
  readonly sw: SoftRaster;
  readonly main: View;
  readonly shadow: View;
  readonly group: THREE.Group;

  constructor(renderer: THREE.WebGPURenderer, trees: BuiltTree[], instances: TreeInstances, textures: ForestTextures) {
    this.renderer = renderer;
    this.u = {
      camPos: uniform(new THREE.Vector3()), // LOD is always computed from the camera, also for the shadow view
      projScale: uniform(1000),
      tau: uniform(1.0), // max screen-space error in pixels
      maxDist: uniform(3000),
      impostorPx: uniform(20), // trees drawn shorter than this (pixels) become impostor quads
      time: uniform(0),
      prevTime: uniform(0), // (last frame's: wind motion vectors)
      wind: uniform(1),
      debug: uniform(0, 'uint'),
      occlusion: uniform(1, 'uint'), // two-phase occlusion culling on/off
      sunDir: uniform(new THREE.Vector3(0, 1, 0)), // towards the sun (the shadow camera's view, reversed)
    };
    this.textures = textures;
    this._buildBuffers(trees, instances);
    this._buildHzb();
    // (the main view's counters: its draw args, stats, retest and software-raster counts in one buffer, see CTR_SIZE)
    this.mainCtr = makeCounters();
    this.ctrLayout = { ARGS, STATS, ITEM_COUNT, RETEST, SW }; // (for the harness probes)
    this.sw = new SoftRaster(this); // tiny clusters: rasterized in compute (src/nanite/softraster.js)
    this.main = this._buildView('main', 1);
    this.shadow = this._buildView('shadow', SHADOW_TAU_MUL);
    this.group = new THREE.Group();
    for (const kind of [0, 1] as const) {
      this.group.add(this._buildMesh(kind, this.main, this.main.sets[0], false));
      // phase 2 draws: on layer PHASE2_LAYER, rendered in a second pass after the HZB is built
      const m2 = this._buildMesh(kind, this.main, this.main.sets[1], false);
      m2.layers.set(PHASE2_LAYER);
      m2.name += '-phase2';
      this.group.add(m2);
      this.group.add(this._buildMesh(kind, this.shadow, this.shadow.sets[0], true));
    }
  }

  // ------------------------------------------------------------------ data
  _buildBuffers(trees: BuiltTree[], instances: TreeInstances): void {
    let nClusters = 0, nVerts = 0, nIdx = 0;
    for (const t of trees) {
      nClusters += t.meta.length / 4;
      nVerts += t.vtx.length / 8;
      nIdx += t.idx.length;
    }
    // (few, merged buffers: a shader may bind only 8 storage buffers on some GPUs, Macs among them)
    const vtx = new Float32Array(nVerts * 8); // per vertex: (x y z u), (nx ny nz v)
    const idx = new Uint32Array(nIdx);
    // per cluster CD_STRIDE vec4s: lod sphere, parent lod sphere, cull sphere, (err, parent err, level, kind), and
    // its meta as uint bits (first index, triangles, level, kind)
    const cBuf = new ArrayBuffer(nClusters * CD_STRIDE * 16);
    const cData = new Float32Array(cBuf), cMeta = new Uint32Array(cBuf);
    const typeInfo: THREE.Vector4[] = [];
    let co = 0, vo = 0, io = 0;
    this.stats = { clusters: nClusters, verts: nVerts, tris: nIdx / 3, types: [] };
    for (const t of trees) {
      const n = t.meta.length / 4;
      // sort by parent error, descending: for a given distance the selectable clusters are then a prefix
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => t.rec[b * 16 + 13] - t.rec[a * 16 + 13]);
      let radius = 0;
      const cy = t.height / 2;
      order.forEach((src, k) => {
        const d = co + k, r = t.rec.subarray(src * 16, src * 16 + 16);
        const o = d * CD_STRIDE * 4;
        cData.set(r, o);
        cMeta[o + 16] = t.meta[src * 4] + io;
        cMeta[o + 17] = t.meta[src * 4 + 1];
        cMeta[o + 18] = t.meta[src * 4 + 2];
        cMeta[o + 19] = t.meta[src * 4 + 3];
        for (const s of [r.subarray(0, 4), r.subarray(4, 8), r.subarray(8, 12)])
          radius = Math.max(radius, Math.hypot(s[0], s[1] - cy, s[2]) + s[3]);
      });
      for (let i = 0; i < t.idx.length; i++) idx[io + i] = t.idx[i] + vo;
      const nv = t.vtx.length / 8;
      vtx.set(t.vtx, vo * 8);
      typeInfo.push(new THREE.Vector4(co, n, radius, t.height));
      this.stats.types.push({ name: t.variant.preset, ...t.stats, radius: +radius.toFixed(1) });
      co += n;
      vo += nv;
      io += t.idx.length;
    }
    const sb = (arr: Float32Array | Uint32Array, item: number) => new THREE.StorageBufferAttribute(arr, item);
    this.vtx = storage(sb(vtx, 4), 'vec4', nVerts * 2).toReadOnly();
    this.idx = storage(sb(idx, 1), 'uint', nIdx).toReadOnly();
    this.cData = storage(sb(cData, 4), 'vec4', nClusters * CD_STRIDE).toReadOnly();
    this.typeInfo = uniformArray<'vec4'>(typeInfo, 'vec4');

    this.instanceCount = instances.a.length / 4;
    this.treeCount = instances.trees;
    // per tree two vec4s: a = (x, y, z, scale), b = (cos, sin, type, wind phase)
    const inst = new Float32Array(this.instanceCount * 8);
    for (let i = 0; i < this.instanceCount; i++) {
      inst.set(instances.a.subarray(i * 4, i * 4 + 4), i * 8);
      inst.set(instances.b.subarray(i * 4, i * 4 + 4), i * 8 + 4);
    }
    this.inst = storage(sb(inst, 4), 'vec4', this.instanceCount * 2).toReadOnly();
  }

  // ------------------------------------------------------------------ buffer accessors (node -> node)
  /** Tree i's position and scale. */
  _a(i: Uint) {
    return this.inst.element(i.mul(2));
  }
  /** Tree i's rotation (cos, sin), type and wind phase. */
  _b(i: Uint) {
    return this.inst.element(i.mul(2).add(1));
  }
  /** Cluster c's k-th vec4: 0 LOD sphere, 1 parent LOD sphere, 2 culling sphere, 3 (err, parent err, level, kind). */
  _cd(c: Uint, k: number) {
    return this.cData.element(c.mul(CD_STRIDE).add(k));
  }
  /** Cluster c's (first index, triangles, level, kind). */
  _meta(c: Uint) {
    return bitcast(this.cData.element(c.mul(CD_STRIDE).add(4)), 'uvec4') as unknown as UVec4; // (bitcast is untyped)
  }
  /** Vertex vi: (x, y, z, u) for k = 0, (nx, ny, nz, v) for k = 1. */
  _vtx(vi: Uint, k: number) {
    return this.vtx.element(vi.mul(2).add(k));
  }

  // ------------------------------------------------------------------ per frame
  _cull(view: View, camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    const projView = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const f = new THREE.Frustum().setFromProjectionMatrix(projView);
    f.planes.forEach((p, i) => view.planeValues[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant));
    const r = this.renderer;
    view.ran = true; // (its buffers exist on the GPU from now on)
    for (const set of view.sets) r.compute(set.reset); // (phase 2 draws nothing unless occlusion() runs)
    if (view.retest) r.compute(view.retest.reset);
    const A = view.sets[0];
    r.compute(view.instances);
    r.compute(A.clampDispatch);
    r.compute(A.clusters, A.dispatchAttr);
    r.compute(A.clampDraw);
  }

  /** Runs the GPU culling for the camera and (if given) the shadow camera. `size`: drawing buffer pixels. */
  update(camera: THREE.PerspectiveCamera, size: THREE.Vector2, time: number, shadowCamera: THREE.Camera | null = null): void {
    const viewportHeight = size.y;
    const u = this.u;
    u.prevTime.value = u.time.value;
    u.time.value = time;
    if (this.frozen) return;
    u.camPos.value.copy(camera.position);
    // both views measure LOD from the camera (the shadow view too, so casters match what's seen)
    for (const v of [this.main, this.shadow]) v.lodPos.value.copy(camera.position).add(v.lodShift);
    u.projScale.value = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    // a zoomed view (narrow fov) wants more detail on screen, but the shadow map's resolution doesn't change:
    // keep the shadow casters' LOD where it is unzoomed
    // (the main view gets full zoomed detail, as if 5x closer: the narrow view culls most of the forest, and the
    // auto quality trims tau if it's still too much)
    this.shadow.tauMul.value = SHADOW_TAU_MUL * (camera.userData.zoom ?? 1);
    this.sw.begin(this.renderer, camera, size.x, size.y);
    this._cull(this.main, camera);
    if (shadowCamera) {
      shadowCamera.updateMatrixWorld();
      u.sunDir.value.set(0, 0, 1).transformDirection(shadowCamera.matrixWorld); // (a camera looks down its -z)
      this._cull(this.shadow, shadowCamera);
    }
  }

  /** Software-rasterizes the tiny clusters both phases listed (call after occlusion(), before the phase 2 render). */
  rasterize(camera: THREE.Camera, width: number, height: number): void {
    this.sw.rasterize(this.renderer, camera, width, height);
  }

  /** Reads back the counters (async, for the overlay/harness), summed over the view's sets. */
  async readStats(view: View = this.main): Promise<ForestStats> {
    const out: ForestStats = { barkClusters: 0, leafClusters: 0, barkTris: 0, leafTris: 0, instances: 0, items: 0, impostors: 0, occluded: 0, occludedImpostors: 0, phase2: 0 };
    if (!view.ran) return out;
    const get = (a: THREE.BufferAttribute) => this.renderer.getArrayBufferAsync(a);
    const sets = view.sets.filter((s, k) => k === 0 || s.ran);
    const [flags, ctrBuf] = await Promise.all([
      view === this.main ? get(view.impFlagAttr) : Promise.resolve(new ArrayBuffer(4)),
      get(view.ctr.attr),
    ]);
    const ctr = new Uint32Array(ctrBuf);
    sets.forEach((set, k) => {
      const b = set.base, s = b + STATS;
      out.barkClusters += ctr[b + ARGS.bark + 1];
      out.leafClusters += ctr[b + ARGS.leaf + 1];
      out.barkTris += ctr[s];
      out.leafTris += ctr[s + 1];
      out.instances += ctr[s + 2];
      out.occluded += ctr[s + 3];
      out.occludedImpostors += ctr[s + 4];
      out.items += ctr[b + ITEM_COUNT];
      if (k === 1) out.phase2 = ctr[s + 2];
    });
    out.impostors = countFlags(flags);
    if (view === this.main) Object.assign(out, await this.sw.readStats(this.renderer));
    return out;
  }
}

// the methods live in modules by stage
Object.assign(NaniteForest.prototype, cullingMethods, hzbMethods, drawMethods, billboardMethods);
