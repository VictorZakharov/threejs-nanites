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
import { storage, uniform, uniformArray, uint, vec4, length } from 'three/tsl';
import { SoftRaster } from './softraster.js';
import { SHADOW_TAU_MUL, PHASE2_LAYER } from './constants.js';
import { cullingMethods } from './culling.js';
import { hzbMethods } from './hzb.js';
import { drawMethods } from './draw.js';
import { billboardMethods } from './billboards.js';

function countFlags(buf) {
  const f = new Uint32Array(buf);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i];
  return n;
}

export class NaniteForest {
  constructor(renderer, trees, instances, textures) {
    this.renderer = renderer;
    this.frozen = false;
    this.u = {
      camPos: uniform(new THREE.Vector3()), // LOD is always computed from the camera, also for the shadow view
      projScale: uniform(1000),
      tau: uniform(1.0), // max screen-space error in pixels
      maxDist: uniform(3000),
      impostorPx: uniform(20), // trees drawn shorter than this (pixels) become impostor quads
      time: uniform(0),
      wind: uniform(1),
      debug: uniform(0, 'uint'),
      occlusion: uniform(1, 'uint'), // two-phase occlusion culling on/off
      sunDir: uniform(new THREE.Vector3(0, 1, 0)), // towards the sun (the shadow camera's view, reversed)
    };
    this.textures = textures;
    this._buildBuffers(trees, instances);
    this._buildHzb();
    this.sw = new SoftRaster(this); // tiny clusters: rasterized in compute (src/nanite/softraster.js)
    this.main = this._buildView('main', 1);
    this.shadow = this._buildView('shadow', SHADOW_TAU_MUL);
    this.group = new THREE.Group();
    for (const kind of [0, 1]) {
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
  _buildBuffers(trees, instances) {
    let nClusters = 0, nVerts = 0, nIdx = 0;
    for (const t of trees) {
      nClusters += t.meta.length / 4;
      nVerts += t.vtx.length / 8;
      nIdx += t.idx.length;
    }
    const vA = new Float32Array(nVerts * 4), vB = new Float32Array(nVerts * 4);
    const idx = new Uint32Array(nIdx);
    const cData = new Float32Array(nClusters * 16); // per cluster: lod sphere, parent lod sphere, cull sphere, err
    const cMeta = new Uint32Array(nClusters * 4);
    const typeInfo = [];
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
        cData.set(r, d * 16);
        cMeta[d * 4] = t.meta[src * 4] + io;
        cMeta[d * 4 + 1] = t.meta[src * 4 + 1];
        cMeta[d * 4 + 2] = t.meta[src * 4 + 2];
        cMeta[d * 4 + 3] = t.meta[src * 4 + 3];
        for (const s of [r.subarray(0, 4), r.subarray(4, 8), r.subarray(8, 12)])
          radius = Math.max(radius, Math.hypot(s[0], s[1] - cy, s[2]) + s[3]);
      });
      for (let i = 0; i < t.idx.length; i++) idx[io + i] = t.idx[i] + vo;
      const nv = t.vtx.length / 8;
      for (let i = 0; i < nv; i++) {
        vA.set(t.vtx.subarray(i * 8, i * 8 + 4), (vo + i) * 4);
        vB.set(t.vtx.subarray(i * 8 + 4, i * 8 + 8), (vo + i) * 4);
      }
      typeInfo.push(new THREE.Vector4(co, n, radius, t.height));
      this.stats.types.push({ name: t.variant.preset, ...t.stats, radius: +radius.toFixed(1) });
      co += n;
      vo += nv;
      io += t.idx.length;
    }
    const sb = (arr, item) => new THREE.StorageBufferAttribute(arr, item);
    this.vA = storage(sb(vA, 4), 'vec4', nVerts).toReadOnly();
    this.vB = storage(sb(vB, 4), 'vec4', nVerts).toReadOnly();
    this.idx = storage(sb(idx, 1), 'uint', nIdx).toReadOnly();
    this.cData = storage(sb(cData, 4), 'vec4', nClusters * 4).toReadOnly();
    this.cMeta = storage(sb(cMeta, 4), 'uvec4', nClusters).toReadOnly();
    this.typeInfo = uniformArray(typeInfo, 'vec4');

    this.instanceCount = instances.a.length / 4;
    this.instA = storage(sb(instances.a, 4), 'vec4', this.instanceCount).toReadOnly();
    this.instB = storage(sb(instances.b, 4), 'vec4', this.instanceCount).toReadOnly();
  }

  // ------------------------------------------------------------------ per frame
  _cull(view, camera) {
    camera.updateMatrixWorld();
    const projView = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const f = new THREE.Frustum().setFromProjectionMatrix(projView);
    f.planes.forEach((p, i) => view.planes.array[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant));
    const r = this.renderer;
    view.ran = true; // (its buffers exist on the GPU from now on)
    for (const set of view.sets) r.compute(set.reset); // (phase 2 draws nothing unless occlusion() runs)
    if (view.resetRetest) r.compute(view.resetRetest);
    const A = view.sets[0];
    r.compute(view.instances);
    r.compute(A.clampDispatch);
    r.compute(A.clusters, A.dispatchAttr);
    r.compute(A.clampDraw);
  }

  /** Runs the GPU culling for the camera and (if given) the shadow camera. `size`: drawing buffer pixels. */
  update(camera, size, time, shadowCamera = null) {
    const viewportHeight = size.y;
    const u = this.u;
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
  rasterize(camera, width, height) {
    this.sw.rasterize(this.renderer, camera, width, height);
  }

  /** Reads back the counters (async, for the overlay/harness), summed over the view's sets. */
  async readStats(view = this.main) {
    const out = { barkClusters: 0, leafClusters: 0, barkTris: 0, leafTris: 0, instances: 0, items: 0, impostors: 0, occluded: 0, occludedImpostors: 0, phase2: 0 };
    if (!view.ran) return out;
    const get = (a) => this.renderer.getArrayBufferAsync(a);
    const sets = view.sets.filter((s, k) => k === 0 || s.ran);
    const [flags, ...per] = await Promise.all([
      view === this.main ? get(view.impFlagAttr) : Promise.resolve(new ArrayBuffer(4)),
      ...sets.map((s) => Promise.all([get(s.barkArgsAttr), get(s.leafArgsAttr), get(s.statsAttr), get(s.itemCountAttr)])),
    ]);
    per.forEach(([bark, leaf, st, disp], k) => {
      const b = new Uint32Array(bark), l = new Uint32Array(leaf), s = new Uint32Array(st);
      out.barkClusters += b[1];
      out.leafClusters += l[1];
      out.barkTris += s[0];
      out.leafTris += s[1];
      out.instances += s[2];
      out.occluded += s[3];
      out.occludedImpostors += s[4];
      out.items += new Uint32Array(disp)[0];
      if (k === 1) out.phase2 = s[2];
    });
    out.impostors = countFlags(flags);
    if (view === this.main) Object.assign(out, await this.sw.readStats(this.renderer));
    return out;
  }
}

// the methods live in modules by stage
Object.assign(NaniteForest.prototype, cullingMethods, hzbMethods, drawMethods, billboardMethods);
