// GPU-driven cluster LOD renderer ("nanite"): many instances of a few mesh types, each type a cluster DAG.
//
// Per frame, entirely on the GPU (no readback):
//   1. reset      zero the indirect dispatch/draw counters
//   2. instances  one thread per instance: frustum + distance cull, then from its distance work out how many of its
//                 clusters could possibly be selected (clusters are sorted by parent error, so it's a prefix found by
//                 binary search) and emit 64-cluster work items for them
//   3. clusters   (indirect dispatch) one thread per candidate cluster: DAG cut test
//                 (own projected error <= threshold < parent projected error) + frustum cull, append to bark/leaf list
//   4. draw       two indirect draws (bark, leaves); each draw instance is one cluster, the vertex shader pulls its
//                 triangles from storage buffers (128 tris max, the rest degenerate). In the main view, clusters of
//                 tiny triangles go to the software rasterizer instead (src/nanite/softraster.js).
// Steps 1-3 run twice: for the camera, and for the sun's shadow map (its own frustum, coarser LOD). The shadow
// meshes live on layer 1, which only the shadow camera sees.
//
// What's the application's comes in through `look` (gpu/look.ts: a world-space curve, vertex motion, colours) and the
// types, instances and textures it passes (NaniteType, NaniteInstances, NaniteTextures in gpu/types.ts).
import * as THREE from 'three/webgpu';
import { uniform, bitcast, float } from 'three/tsl';
import type { StorageBufferNode, UniformArrayNode } from 'three/webgpu';
import { SoftRaster } from './softraster.ts';
import { Splats } from './splats.ts';
import { SHADOW_TAU_MUL, PHASE2_LAYER, CD_STRIDE, makeCounters, ARGS, STATS, ITEM_COUNT, RETEST, SW, IMP_ARGS, SPLAT, LIST_CAP } from './constants.ts';
import { cullingMethods } from './culling.ts';
import { hzbMethods } from './hzb.ts';
import { drawMethods } from './draw.ts';
import { billboardMethods } from './billboards.ts';
import { bufferMethods, type NaniteArrays } from './buffers.ts';
import { computeBatch } from '../three-gaps.ts';
import { InstanceChunks, CHUNK } from './chunks.ts';
import { defaultLook, type NaniteLook } from './look.ts';
import type { DagStats } from '../dag/types.ts';
import type { Float, Uint, UVec4 } from '../types.ts';
import type { Counters, NaniteInstances, NaniteStats, NaniteTextures, NaniteType, NaniteUniforms, View } from './types.ts';
import type { Hzb } from './hzb.ts';

type TypeStats = DagStats & { name: string; radius: number };

const CAST_CULL = new URLSearchParams(location.search).get('castcull') !== '0'; // (?castcull=0: every caster in the map)
const CAST_SLACK = 60; // m: how much lower than a tree's base its shadow may land (a slope)

// The stage modules' methods, attached to the prototype at the end of this file.
export interface NaniteRenderer
  extends Omit<typeof cullingMethods, never>, Omit<typeof hzbMethods, never>, Omit<typeof drawMethods, never>, Omit<typeof billboardMethods, never>,
    Omit<typeof bufferMethods, never> {}

export class NaniteRenderer {
  readonly renderer: THREE.WebGPURenderer;
  frozen = false;
  /** Occlusion culling switched on (the menu, ?occ=0); u.occlusion is this and low enough to pay (main.ts). */
  occlusionOn = true;
  /** The shadow view ran this frame (its stats are stale otherwise: shadows off, or the average shadow from high up). */
  shadowActive = false;
  readonly u: NaniteUniforms;
  readonly textures: NaniteTextures;
  readonly look: NaniteLook;
  // GPU data (see _buildBuffers in buffers.ts and the accessors)
  arrays!: NaniteArrays; // (their CPU copies: a late model is written into them)
  vtx!: StorageBufferNode<'vec4'>;
  idx!: StorageBufferNode<'uint'>;
  cData!: StorageBufferNode<'vec4'>;
  inst!: StorageBufferNode<'vec4'>;
  instA!: Float32Array; // (the instances' (x, y, z, scale) and (cos, sin, type, phase): a late model refits the chunks)
  instB!: Float32Array;
  typeInfo!: UniformArrayNode<'vec4'>; // per type (first cluster, clusters, radius, height)
  typeValues!: THREE.Vector4[]; // (its values)
  chunks!: InstanceChunks; // (the instances in compact runs: the instance passes cull them on the CPU first)
  // per tree type its impostor frame (width, height in metres at scale 1), from the atlas once it's baked (until
  // then wide: no impostor is thinned out, see _impostorKept)
  impFrameValues!: THREE.Vector4[];
  impFrame!: UniformArrayNode<'vec4'>;
  instanceCount = 0;
  stats!: { clusters: number; verts: number; tris: number; types: TypeStats[] };
  hzb!: Hzb;
  hzbReady = false;
  readonly mainFrustum = new THREE.Frustum(); // (this frame's camera frustum: the shadow view's casters must reach it)
  /** The impostors' colour gains per tree type (live uniforms: harness --typematch=calibrate adjusts them). */
  impGains: { side: UniformArrayNode<'vec3'>; top: UniformArrayNode<'vec3'> } | null = null;
  readonly mainCtr: Counters;
  readonly ctrLayout: { ARGS: typeof ARGS; STATS: number; ITEM_COUNT: number; RETEST: number; SW: number; LIST_CAP: number; PLANET_RADIUS: number };
  readonly sw: SoftRaster;
  readonly splats: Splats;
  readonly main: View;
  readonly shadow: View;
  readonly group: THREE.Group;

  /** `types`: the mesh types, in the order the instances' b.z refers to them; `look`: see gpu/look.ts. */
  constructor(renderer: THREE.WebGPURenderer, types: NaniteType[], instances: NaniteInstances, textures: NaniteTextures, look: NaniteLook = defaultLook()) {
    this.renderer = renderer;
    this.look = look;
    this.u = {
      camPos: uniform(new THREE.Vector3()), // LOD is always computed from the camera, also for the shadow view
      projScale: uniform(1000),
      tau: uniform(1.0), // max screen-space error in pixels
      maxDist: uniform(3000),
      impostorPx: uniform(20), // trees drawn shorter than this (pixels) become impostor quads
      firstModel: uniform(0, 'uint'), // instances from here on (the statues) are never impostors (see switchPx)
      time: uniform(0),
      prevTime: uniform(0), // (last frame's: motion vectors)
      debug: uniform(0, 'uint'),
      occlusion: uniform(1, 'uint'), // two-phase occlusion culling on/off
      sunDir: uniform(new THREE.Vector3(0, 1, 0)), // towards the sun (the shadow camera's view, reversed)
      castLen: uniform(0), // how far a caster's shadow can reach from it (m; 0: no test, ?castcull=0; see CastTest)
    };
    this.textures = textures;
    this._buildBuffers(types, instances);
    this._buildHzb();
    // (the main view's counters: its draw args, stats, retest and software-raster counts in one buffer, see CTR_SIZE)
    this.mainCtr = makeCounters();
    this.ctrLayout = { ARGS, STATS, ITEM_COUNT, RETEST, SW, LIST_CAP, PLANET_RADIUS: look.curveRadius }; // (for the harness probes)
    this.sw = new SoftRaster(this); // tiny clusters: rasterized in compute (src/nanite/softraster.js)
    this.splats = new Splats(this); // tiny impostors: splatted into its visibility buffer (src/nanite/splats.ts)
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

  // ------------------------------------------------------------------ buffer accessors (node -> node)
  /** Tree i's position and scale. */
  _a(i: Uint) {
    return this.inst.element(i.mul(2));
  }
  /** Tree i's rotation (cos, sin), type and the application's float (the forest's wind phase). */
  _b(i: Uint) {
    return this.inst.element(i.mul(2).add(1));
  }
  /** Cluster c's k-th vec4: 0 LOD sphere, 1 parent LOD sphere, 2 culling sphere, 3 (err, parent err, level, kind). */
  _cd(c: Uint, k: number) {
    return this.cData.element(c.mul(CD_STRIDE).add(k));
  }
  /** How far the look's motion can move a part (see NaniteLook.motionMargin): 0 without one. */
  _margin(height: Float, top: Float, s: Float, type: Float): Float {
    return this.look.motionMargin ? this.look.motionMargin(height, top, s, type) : float(0);
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
    const A = view.sets[0];
    // the chunks of instances in view (the instance pass runs a thread per instance slot of each)
    if (view === this.main) this.mainFrustum.copy(f);
    const cast = view === this.shadow && this.u.castLen.value > 0 ? { frustum: this.mainFrustum, dir: this.u.sunDir.value, len: this.u.castLen.value } : null;
    const seen = this.chunks.visible(f, this.look.viewer, view.lodPos.value, this.u.maxDist.value, view.chunkValues, cast);
    computeBatch(r, [
      ...view.sets.map((set) => set.reset), // (phase 2 draws nothing unless occlusion() runs)
      ...(view.retest ? [view.retest.reset] : []),
      view.impReset,
      [view.instances, seen * CHUNK],
      A.clampDispatch,
      [A.clusters, A.dispatchAttr],
      A.clampDraw,
    ]);
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
    this.splats.begin();
    this.main.impRetest.value = this.willOcclude(size.x, size.y) ? 1 : 0; // (phase 2 lists the impostors)
    this._cull(this.main, camera);
    this.shadowActive = Boolean(shadowCamera);
    if (shadowCamera) {
      shadowCamera.updateMatrixWorld();
      u.sunDir.value.set(0, 0, 1).transformDirection(shadowCamera.matrixWorld); // (a camera looks down its -z)
      // Casters only where their shadow can land in the camera's view: swept from the tallest tree's top down to
      // ground up to CAST_SLACK lower (a slope) along the sun. The map covers a square kilometres wide from high up,
      // and all of it was drawn: zoomed in looking down from 544 m, 38M shadow triangles, 13 ms (`zoomdown`).
      u.castLen.value = CAST_CULL ? (this.chunks.maxHeight + CAST_SLACK) / Math.max(u.sunDir.value.y, 0.15) : 0;
      this._cull(this.shadow, shadowCamera);
    }
  }

  /** Software-rasterizes the tiny clusters both phases listed (call after occlusion(), before the phase 2 render). */
  rasterize(camera: THREE.Camera, width: number, height: number): void {
    this.sw.rasterize(this.renderer, camera, width, height);
  }

  /** Reads back the counters (async, for the overlay/harness), summed over the view's sets. */
  async readStats(view: View = this.main): Promise<NaniteStats> {
    const out: NaniteStats = { barkClusters: 0, leafClusters: 0, barkTris: 0, leafTris: 0, instances: 0, items: 0, impostors: 0, occluded: 0, occludedImpostors: 0, phase2: 0 };
    if (!view.ran) return out;
    const get = (a: THREE.BufferAttribute) => this.renderer.getArrayBufferAsync(a);
    const sets = view.sets.filter((s, k) => k === 0 || s.ran);
    const ctr = new Uint32Array(await get(view.ctr.attr));
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
    out.impostors = ctr[IMP_ARGS + 1];
    if (view === this.main) out.splats = ctr[SPLAT];
    if (view === this.main) Object.assign(out, await this.sw.readStats(this.renderer));
    return out;
  }
}

// the methods live in modules by stage
Object.assign(NaniteRenderer.prototype, cullingMethods, hzbMethods, drawMethods, billboardMethods, bufferMethods);
