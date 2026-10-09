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
//                 tiny triangles go to the software rasterizer instead (src/softraster.js).
// Steps 1-3 run twice: for the camera, and for the sun's shadow map (its own frustum, coarser LOD). The shadow
// meshes live on layer 1, which only the shadow camera sees.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, storage, uniform, uniformArray, instanceIndex, vertexIndex, workgroupId, localId, numWorkgroups,
  uint, float, vec2, vec3, vec4, uvec2, atomicAdd, atomicStore, select, max, min, varying, normalLocal, texture,
  sin, mix, hash, length, dot, clamp, smoothstep, dFdx, dFdy, log2, normalViewGeometry, cross, fract, screenCoordinate,
  cameraViewMatrix, normalize, exp2, ivec2, int, textureLoad,
} from 'three/tsl';
import { curve } from './planet.js';
import { IMPOSTOR_CUT } from './impostors.js';
import { SoftRaster } from './softraster.js';

/**
 * Coverage-preserving alpha for the leaf array texture (see coverageScales in main.js): scales alpha by the
 * precomputed factor of the mip level being sampled, so cut-out leaves keep their density at any size.
 */
export function makeLeafAlpha(leafTex, uvNode) {
  const levels = leafTex.userData.levels;
  const scaled = makeLeafAlphaLod(leafTex);
  return (a, layer) => scaled(a, layer, log2(max(length(dFdx(uvNode)), length(dFdy(uvNode))).mul(leafTex.image.width)));
}

/** The same with the mip level given (`lod`), for where there are no derivatives (the software rasterizer). */
export function makeLeafAlphaLod(leafTex) {
  const levels = leafTex.userData.levels;
  const scaleArr = uniformArray(leafTex.userData.alphaScales, 'float');
  return (a, layer, lodIn) => {
    const lod = clamp(lodIn, 0, levels - 1.001);
    const i0 = uint(layer).mul(levels).add(uint(lod.floor()));
    return a.mul(mix(scaleArr.element(i0), scaleArr.element(i0.add(1)), lod.fract()));
  };
}

/** Leaf colour before lighting (shared by the hardware draw and the software rasterizer's resolve). */
export function leafColour(rgb, layerI, tint) {
  // per-tree hue variation, x 0.76 (meant as "darker towards the bottom of the crown" from the normal, but the
  // fragment stage's normalLocal is the geometry's zero normal attribute, so it always was this constant, and the
  // impostor colours are calibrated against it)
  const inner = 0.76;
  // per-texture tint (layer 2 = aspen, an autumn-yellow texture: pull it back to summer green)
  // and layer 3 = pine, olive needles that read yellow in full sun: darker, bluer)
  const layerTint = select(
    layerI.equal(2),
    vec3(0.5, 0.82, 0.85),
    select(layerI.equal(3), vec3(0.62, 0.78, 1.0), vec3(1)),
  );
  return rgb.mul(layerTint).mul(vec3(tint.mul(0.92), tint, tint.mul(0.8))).mul(inner).mul(1.2);
}

/** Bark colour before lighting. */
export const barkColour = (rgb) => rgb.mul(vec3(0.9, 0.86, 0.8));

/** Per-tree brightness variation. */
export const treeTint = (inst) => hash(inst).mul(0.35).add(0.8);

/** Screen-space dither in [0, 1) (interleaved gradient noise): a fixed pattern, so a cross-fade doesn't shimmer. */
export const ditherAt = (xy) => fract(dot(xy, vec2(0.06711056, 0.00583715)).fract().mul(52.9829189));
const dither = () => ditherAt(screenCoordinate.xy);

function countFlags(buf) {
  const f = new Uint32Array(buf);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i];
  return n;
}

const TOP_GROW = Number(new URLSearchParams(location.search).get('topgrow') ?? 1.25);
// extra colour gains on top of each variant's impGain (side / top-down views), for experiments: ?impgain=r,g,b
const gainParam = (name) => (new URLSearchParams(location.search).get(name) ?? '1,1,1').split(',').map(Number);
const IMP_GAIN = gainParam('impgain');
const IMP_GAIN_TOP = gainParam('impgaintop');
// debug 4: a flat, unlit colour per tree type, in geometry and impostors alike (harness --typematch masks with it;
// keep in sync with TYPE_IDS in tools/harness/typematch.mjs): six hues 60 degrees apart, told apart by hue after
// fog and tone mapping; the dull olive ground and pale sky aren't saturated enough to count.
export const TYPE_IDS = [[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], [1, 0, 1]];
export const typeId = (type) => {
  let c = vec3(...TYPE_IDS[TYPE_IDS.length - 1]);
  for (let i = TYPE_IDS.length - 2; i >= 0; i--) c = select(uint(type).mod(TYPE_IDS.length).equal(i), vec3(...TYPE_IDS[i]), c);
  return c;
};
const MIN_PX = 2; // impostors are never drawn narrower than this (pixels)
export const FADE_HI = 1.3; // impostor cross-fade band: [1, FADE_HI] x impostorPx (geometry count unchanged)
const SHADOW_TAU_MUL = 2.5; // shadow casters may be coarser than what's seen
export const MAX_TRIS = 128;
const WG = 64;
const MAX_ITEMS = 1 << 20; // max 64-cluster work items per view (dispatched 2D: 65535 workgroups per dimension)
const MAX_DIM = 65535;
export const LIST_CAP = 1 << 20; // max visible clusters per list
// marks an impostor in the phase 2 retest list (tree indices are below it); a tree in the cross-fade band is listed
// both as geometry and as an impostor
const IMP_BIT = 0x80000000;
const HZB_LEVELS = 13;
const HZB_LEVEL0_MAX = 2048 * 2048; // level 0 texels (half resolution): screens up to 4096 x 4096
const HZB_FLOATS = Math.ceil(HZB_LEVEL0_MAX * 1.34) + 64;

const rotY = (p, cs, sn) => vec3(p.x.mul(cs).sub(p.z.mul(sn)), p.y, p.x.mul(sn).add(p.z.mul(cs)));
/** How far wind can push a tree's parts (m), for a tree this tall: added to spheres in the occlusion tests. */
const windMargin = (height) => height.mul(0.1).add(0.5);

/** Layer of the main view's phase 2 meshes (see occlusion()). */
export const PHASE2_LAYER = 2;

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
    };
    this.textures = textures;
    this._buildBuffers(trees, instances);
    this._buildHzb();
    this.sw = new SoftRaster(this); // tiny clusters: rasterized in compute (src/softraster.js)
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

  // ------------------------------------------------------------------ culling (one set of passes per view)
  //
  // A "set" is one cull -> draw chain: work items, the indirect cluster dispatch, bark/leaf cluster lists and their
  // indirect draw args. The shadow view has one set. The main view has two, for Nanite-style two-phase occlusion
  // culling against a max-depth pyramid (HZB):
  //   phase 1 (set A)  trees and clusters are tested against *last* frame's HZB (with last frame's camera); what
  //                    passes is drawn (with terrain, sky and impostors), what fails goes on a retest list
  //   HZB              rebuilt from this frame's phase 1 depth
  //   phase 2 (set B)  the retest lists are tested again against the new HZB and what's visible is drawn too.
  // Everything visible is drawn in the frame it becomes visible (no one-frame holes when the camera moves), and the
  // test is per cluster: the trunk and lower crown behind the canopy, the far side of a tree, are skipped too.
  /** occ: null (no occlusion), 'retest' (phase 1: failures go to the retest list), 'final' (phase 2) */
  _buildSet(v, tau, occ) {
    const sb = (arr, item) => new THREE.StorageBufferAttribute(arr, item);
    const u = this.u;
    const set = {
      itemsAttr: sb(new Uint32Array(MAX_ITEMS * 2), 2),
      dispatchAttr: new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4),
      barkArgsAttr: new THREE.IndirectStorageBufferAttribute(new Uint32Array([MAX_TRIS * 3, 0, 0, 0]), 4),
      leafArgsAttr: new THREE.IndirectStorageBufferAttribute(new Uint32Array([MAX_TRIS * 3, 0, 0, 0]), 4),
      statsAttr: sb(new Uint32Array(5), 1), // bark tris, leaf tris, trees, occluded trees, occluded impostors
      itemCountAttr: sb(new Uint32Array(1), 1),
      barkListAttr: sb(new Uint32Array(LIST_CAP * 2), 2),
      leafListAttr: sb(new Uint32Array(LIST_CAP * 2), 2),
    };
    const items = storage(set.itemsAttr, 'uvec2', MAX_ITEMS);
    const dispatchA = storage(set.dispatchAttr, 'uint', 4).toAtomic();
    const barkA = storage(set.barkArgsAttr, 'uint', 4).toAtomic();
    const leafA = storage(set.leafArgsAttr, 'uint', 4).toAtomic();
    set.statsA = storage(set.statsAttr, 'uint', 5).toAtomic();
    const barkList = storage(set.barkListAttr, 'uvec2', LIST_CAP);
    const leafList = storage(set.leafListAttr, 'uvec2', LIST_CAP);

    /**
     * Appends cluster c of tree inst to the bark or leaf draw list; in the main view a cluster that's tiny on screen
     * (centre cw, radius rad) goes to the software rasterizer's list instead.
     */
    set.append = (inst, c, cw, rad) => {
      const tris = this.cMeta.element(c).y;
      const isBark = this.cData.element(c.mul(4).add(3)).w.lessThan(0.5);
      const hwAppend = (chain) =>
        chain(isBark, () => {
          const slot = atomicAdd(barkA.element(1), uint(1)).toVar();
          atomicAdd(set.statsA.element(0), tris);
          If(slot.lessThan(LIST_CAP), () => barkList.element(slot).assign(uvec2(inst, c)));
        }).Else(() => {
          const slot = atomicAdd(leafA.element(1), uint(1)).toVar();
          atomicAdd(set.statsA.element(1), tris);
          If(slot.lessThan(LIST_CAP), () => leafList.element(slot).assign(uvec2(inst, c)));
        });
      if (occ) {
        const sw = If(this.sw.wants(cw, rad, tris), () => this.sw.append(inst, c, tris));
        hwAppend((cond, fn) => sw.ElseIf(cond, fn));
      } else hwAppend(If);
    };

    set.reset = Fn(() => {
      atomicStore(dispatchA.element(0), uint(0));
      atomicStore(barkA.element(1), uint(0));
      atomicStore(leafA.element(1), uint(0));
      for (let i = 0; i < 5; i++) atomicStore(set.statsA.element(i), uint(0));
    })().compute(1, [1]);

    /** Emits the work items for tree i (called from an instance pass). */
    set.emit = (i, ti, s, dCam, r) => {
      // clusters whose parent error (local units) is below this can never be selected for this tree
      const thr = tau.mul(max(dCam.sub(r), 0.05)).div(u.projScale.mul(s));
      const start = uint(ti.x);
      const lo = uint(0).toVar(), hi = uint(ti.y).toVar();
      Loop(14, () => {
        If(lo.lessThan(hi), () => {
          const mid = lo.add(hi).div(2).toVar();
          If(this.cData.element(start.add(mid).mul(4).add(3)).y.greaterThan(thr), () => lo.assign(mid.add(1))).Else(() => hi.assign(mid));
        });
      });
      const n = lo;
      const nItems = n.add(WG - 1).div(WG).toVar();
      const base = atomicAdd(dispatchA.element(0), nItems).toVar();
      atomicAdd(set.statsA.element(2), uint(1));
      Loop({ start: uint(0), end: nItems, type: 'uint', condition: '<' }, ({ i: k }) => {
        If(base.add(k).lessThan(MAX_ITEMS), () => {
          items.element(base.add(k)).assign(uvec2(i, k.mul(WG).bitOr(n.shiftLeft(16))));
        });
      });
    };

    // turn the item count into a 2D dispatch; the cluster pass gets the count from a separate buffer (a buffer can't
    // be both the indirect args and a storage binding of the same dispatch)
    const dispatchRW = storage(set.dispatchAttr, 'uint', 4);
    const itemCountW = storage(set.itemCountAttr, 'uint', 1);
    set.clampDispatch = Fn(() => {
      const total = min(dispatchRW.element(0), uint(MAX_ITEMS)).toVar();
      itemCountW.element(0).assign(total);
      dispatchRW.element(0).assign(min(total, uint(MAX_DIM)));
      dispatchRW.element(1).assign(total.add(MAX_DIM - 1).div(MAX_DIM));
    })().compute(1, [1]);

    const itemCount = storage(set.itemCountAttr, 'uint', 1).toReadOnly();
    set.clusters = Fn(() => {
      const itemIdx = workgroupId.x.add(workgroupId.y.mul(numWorkgroups.x));
      const item = items.element(min(itemIdx, uint(MAX_ITEMS - 1)));
      const inst = item.x;
      const local = item.y.bitAnd(0xffff).add(localId.x);
      const n = item.y.shiftRight(16);
      If(local.lessThan(n).and(itemIdx.lessThan(itemCount.element(0))), () => {
        const a = this.instA.element(inst);
        const b = this.instB.element(inst);
        const ti = this.typeInfo.element(uint(b.z));
        const c = uint(ti.x).add(local).toVar();
        const s = a.w;
        const lod = this.cData.element(c.mul(4)), par = this.cData.element(c.mul(4).add(1));
        const cs = this.cData.element(c.mul(4).add(2)), e = this.cData.element(c.mul(4).add(3));
        const projErr = (sph, err) => {
          const w = a.xyz.add(rotY(sph.xyz, b.x, b.y).mul(s));
          const dist = max(length(w.sub(v.lodPos)).sub(sph.w.mul(s)), 0.05);
          return err.mul(s).mul(u.projScale).div(dist);
        };
        // DAG cut: fine enough itself, but the parent group is too coarse
        const cut = projErr(lod, e.x).lessThanEqual(tau).and(projErr(par, e.y).greaterThan(tau));
        If(cut, () => {
          const cw = curve(a.xyz.add(rotY(cs.xyz, b.x, b.y).mul(s))).toVar();
          const keep = v.sphereVisible(cw, cs.w.mul(s)).toVar();
          if (occ) {
            If(keep.and(u.occlusion.equal(1)), () => {
              If(this._hzbOccluded(cw, cs.w.mul(s).add(windMargin(ti.w.mul(s)))), () => {
                keep.assign(false);
                if (occ === 'retest') v.retestCluster(inst, c);
              });
            });
          }
          If(keep, () => set.append(inst, c, cw, cs.w.mul(s)));
        });
      });
    })().compute(MAX_ITEMS * WG, [WG]);

    const barkRW = storage(set.barkArgsAttr, 'uint', 4);
    const leafRW = storage(set.leafArgsAttr, 'uint', 4);
    set.clampDraw = Fn(() => {
      barkRW.element(1).assign(min(barkRW.element(1), uint(LIST_CAP)));
      leafRW.element(1).assign(min(leafRW.element(1), uint(LIST_CAP)));
    })().compute(1, [1]);
    return set;
  }

  _buildView(name, tauMul) {
    const u = this.u;
    const main = name === 'main';
    const sb = (arr, item) => new THREE.StorageBufferAttribute(arr, item);
    const v = {
      name,
      planes: uniformArray(Array.from({ length: 6 }, () => new THREE.Vector4()), 'vec4'),
      tauMul: uniform(tauMul),
      lodPos: uniform(new THREE.Vector3()), // where LOD is measured from: the camera (+ a debug shift)
      lodShift: new THREE.Vector3(),
      // per tree: drawn as an impostor this frame? (a flag per tree instead of an appended list: 900k threads
      // appending through one atomic counter took ~5 ms; the impostor draw covers every tree and the vertex shader
      // collapses the unflagged ones, which is far cheaper)
      impFlagAttr: sb(new Uint32Array(main ? this.instanceCount : 1), 1),
    };
    const tau = u.tau.mul(v.tauMul);
    const impFlag = storage(v.impFlagAttr, 'uint', main ? this.instanceCount : 1);
    v.sphereVisible = (c, r) => {
      const ok = uint(1).toVar();
      for (let p = 0; p < 6; p++) {
        const pl = v.planes.element(p);
        If(dot(pl.xyz, c).add(pl.w).lessThan(r.negate()), () => ok.assign(0));
      }
      return ok.equal(1);
    };

    if (main) {
      // phase 1 failures: trees and clusters to test again in phase 2
      const n = this.instanceCount;
      v.retestTreesAttr = sb(new Uint32Array(n), 1);
      v.retestClustersAttr = sb(new Uint32Array(LIST_CAP * 2), 2);
      v.retestCountAttr = sb(new Uint32Array(4), 1); // trees, clusters (appended), trees, clusters (clamped)
      v.retestTreeDispatch = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4);
      v.retestClusterDispatch = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4);
      const retestTrees = storage(v.retestTreesAttr, 'uint', n);
      const retestClusters = storage(v.retestClustersAttr, 'uvec2', LIST_CAP);
      const countA = storage(v.retestCountAttr, 'uint', 4).toAtomic();
      v.retestTree = (i) => {
        const slot = atomicAdd(countA.element(0), uint(1)).toVar();
        If(slot.lessThan(n), () => retestTrees.element(slot).assign(i)); // (a tree can be listed twice, see IMP_BIT)
      };
      v.retestCluster = (inst, c) => {
        const slot = atomicAdd(countA.element(1), uint(1)).toVar();
        If(slot.lessThan(LIST_CAP), () => retestClusters.element(slot).assign(uvec2(inst, c)));
      };
      v.resetRetest = Fn(() => {
        atomicStore(countA.element(0), uint(0));
        atomicStore(countA.element(1), uint(0));
      })().compute(1, [1]);
      // indirect dispatch sizes of the two retest passes (64 threads per workgroup), and the counts they read
      const countRW = storage(v.retestCountAttr, 'uint', 4);
      const dT = storage(v.retestTreeDispatch, 'uint', 4), dC = storage(v.retestClusterDispatch, 'uint', 4);
      v.retestArgs = Fn(() => {
        const nc = min(countRW.element(1), uint(LIST_CAP)).toVar();
        countRW.element(2).assign(min(countRW.element(0), uint(n)));
        countRW.element(3).assign(nc);
        dT.element(0).assign(countRW.element(0).add(WG - 1).div(WG));
        dC.element(0).assign(nc.add(WG - 1).div(WG));
      })().compute(1, [1]);
      v.retestCounts = storage(v.retestCountAttr, 'uint', 4).toReadOnly();
      v.retestTreesRO = storage(v.retestTreesAttr, 'uint', n).toReadOnly();
      v.retestClustersRO = storage(v.retestClustersAttr, 'uvec2', LIST_CAP).toReadOnly();
    }
    v.sets = [this._buildSet(v, tau, main ? 'retest' : null)];
    if (main) v.sets.push(this._buildSet(v, tau, 'final'));

    /** The per-tree basics shared by the instance passes. */
    const treeInfo = (i) => {
      const a = this.instA.element(i);
      const b = this.instB.element(i);
      const ti = this.typeInfo.element(uint(b.z));
      const s = a.w;
      const center = a.xyz.add(vec3(0, ti.w.mul(0.5).mul(s), 0));
      const centerC = curve(center).toVar(); // where the planet's curvature puts it on screen
      const r = ti.z.mul(s);
      const dCam = length(center.sub(v.lodPos)).toVar();
      const px = ti.w.mul(s).mul(u.projScale).div(max(dCam, 0.1)); // projected tree height
      const visible = v.sphereVisible(centerC, r).and(dCam.sub(r).lessThan(u.maxDist)).toVar();
      return { ti, s, centerC, r, dCam, px, visible };
    };

    // phase 1 (and the only pass of the shadow view)
    const setA = v.sets[0];
    v.instances = Fn(() => {
      const i = instanceIndex;
      const { ti, s, centerC, r, dCam, px, visible } = treeInfo(i);
      // between 1 x and FADE_HI x the impostor threshold a tree is drawn both ways, dithered (see dither)
      const far = px.lessThan(u.impostorPx);
      // (impostors cast no shadow: receivers fall back to an average shadow there, see main.js)
      if (main) {
        // impostors are drawn in phase 2 and tested once, against this frame's HZB (retestTreesPass)
        const imp = visible.and(px.lessThan(u.impostorPx.mul(FADE_HI))).toVar();
        impFlag.element(i).assign(select(imp, uint(1), uint(0)));
        If(imp.and(u.occlusion.equal(1)), () => v.retestTree(i.bitOr(IMP_BIT)));
      }
      If(visible.and(far.not()), () => {
        if (main) {
          If(u.occlusion.equal(1).and(this._hzbOccluded(centerC, r.add(windMargin(ti.w.mul(s))))), () => v.retestTree(i)).Else(() => setA.emit(i, ti, s, dCam, r));
        } else {
          setA.emit(i, ti, s, dCam, r);
        }
      });
    })().compute(this.instanceCount, [WG]);

    if (main) {
      const setB = v.sets[1];
      // phase 2: trees that failed phase 1, against the new HZB
      v.retestTreesPass = Fn(() => {
        const k = instanceIndex;
        If(k.lessThan(v.retestCounts.element(2)), () => {
          const e = v.retestTreesRO.element(k);
          const i = e.bitAnd(IMP_BIT - 1);
          const { ti, s, centerC, r, dCam } = treeInfo(i);
          const hidden = this._hzbOccluded(centerC, r.add(windMargin(ti.w.mul(s))));
          If(e.greaterThanEqual(IMP_BIT), () => {
            // an impostor: drop it if hidden
            If(hidden, () => {
              impFlag.element(i).assign(0);
              atomicAdd(setB.statsA.element(4), uint(1));
            });
          })
            .ElseIf(hidden, () => {
              atomicAdd(setB.statsA.element(3), uint(1));
            })
            .Else(() => setB.emit(i, ti, s, dCam, r));
        });
      })().compute(this.instanceCount, [WG]);
      // ... and the clusters that failed phase 1 (of trees that passed)
      v.retestClustersPass = Fn(() => {
        const k = instanceIndex;
        If(k.lessThan(v.retestCounts.element(3)), () => {
          const e = v.retestClustersRO.element(k);
          const inst = e.x, c = e.y;
          const a = this.instA.element(inst), b = this.instB.element(inst);
          const ti = this.typeInfo.element(uint(b.z));
          const s = a.w;
          const cs = this.cData.element(c.mul(4).add(2));
          const cw = curve(a.xyz.add(rotY(cs.xyz, b.x, b.y).mul(s))).toVar();
          If(this._hzbOccluded(cw, cs.w.mul(s).add(windMargin(ti.w.mul(s)))).not(), () => setB.append(inst, c, cw, cs.w.mul(s)));
        });
      })().compute(LIST_CAP, [WG]);
    }
    return v;
  }

  // ------------------------------------------------------------------ HZB (max-depth pyramid of the main view)
  _buildHzb() {
    this.hzb = {
      // level 0 is half resolution (each texel = 2x2 pixels x all MSAA samples)
      buf: storage(new THREE.StorageBufferAttribute(new Float32Array(HZB_FLOATS), 1), 'float', HZB_FLOATS),
      levels: uniformArray(Array.from({ length: HZB_LEVELS }, () => new THREE.Vector4()), 'vec4'), // offset, w, h
      count: uniform(1, 'uint'),
      size: uniform(new THREE.Vector2(1, 1)), // depth buffer pixels
      view: uniform(new THREE.Matrix4()),
      proj: uniform(new THREE.Vector4()), // P00, P11, P22, P32
      near: uniform(0.3),
      passes: [],
      attr: null,
    };
    this.hzb.attr = this.hzb.buf.value;
  }

  /** True if a world-space sphere (planet-curved centre) lies entirely behind the HZB. */
  _hzbOccluded(c, r) {
    const h = this.hzb;
    const res = uint(0).toVar();
    const cv = h.view.mul(vec4(c, 1)).xyz.toVar();
    const d = cv.z.negate().toVar();
    const d0 = d.sub(r).toVar();
    If(d0.greaterThan(h.near), () => {
      const d1 = d.add(r);
      // screen rect: the extremes of the sphere's view-space box over its nearest and farthest depth
      const ext = (lo, hi, k) => {
        const q = [lo.div(d0), lo.div(d1), hi.div(d0), hi.div(d1)];
        return [
          clamp(min(min(q[0], q[1]), min(q[2], q[3])).mul(k), -1, 1),
          clamp(max(max(q[0], q[1]), max(q[2], q[3])).mul(k), -1, 1),
        ];
      };
      const [nx0, nx1] = ext(cv.x.sub(r), cv.x.add(r), h.proj.x);
      const [ny0, ny1] = ext(cv.y.sub(r), cv.y.add(r), h.proj.y);
      const px0 = nx0.mul(0.5).add(0.5).mul(h.size.x), px1 = nx1.mul(0.5).add(0.5).mul(h.size.x);
      const py0 = ny1.mul(-0.5).add(0.5).mul(h.size.y), py1 = ny0.mul(-0.5).add(0.5).mul(h.size.y);
      const size = max(px1.sub(px0), py1.sub(py0));
      // a level where the rect spans at most 4 texels a side (a level L texel is 2^(L+1) pixels), max of those
      // (finer than the usual 2x2: near the horizon a coarse texel takes in sky above the treeline)
      const L = uint(clamp(log2(max(size.div(3), 1)).ceil().sub(1), 0, float(h.count).sub(1))).toVar();
      const lv = h.levels.element(L);
      const scale = exp2(float(L).add(1));
      const off = uint(lv.x), w = uint(lv.y), hh = uint(lv.z);
      const tx = (p, n) => min(uint(max(p.div(scale).floor(), 0)), n.sub(1));
      const tx0 = tx(px0, w), tx1 = tx(px1, w), ty0 = tx(py0, hh), ty1 = tx(py1, hh);
      const farthest = float(0).toVar();
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const x = min(tx0.add(i), tx1), y = min(ty0.add(j), ty1);
          farthest.assign(max(farthest, h.buf.element(off.add(y.mul(w)).add(x))));
        }
      // depth (0..1) of the sphere's nearest point
      const zNear = h.proj.z.mul(d0.negate()).add(h.proj.w).div(d0);
      If(zNear.greaterThan(farthest), () => res.assign(1));
    });
    return res.equal(1);
  }

  /** The depth buffer the HZB is built from (the main view's render target). */
  setDepthSource(depthTexture, samples) {
    const h = this.hzb;
    h.passes = [];
    for (let L = 0; L < HZB_LEVELS; L++) {
      const node = Fn(() => {
        const idx = instanceIndex;
        const lv = h.levels.element(L);
        const w = uint(lv.y), hh = uint(lv.z);
        If(idx.lessThan(w.mul(hh)), () => {
          const x = idx.mod(w), y = idx.div(w);
          const m = float(0).toVar();
          if (L === 0) {
            const W = uint(h.size.x), H = uint(h.size.y);
            for (let dy = 0; dy < 2; dy++)
              for (let dx = 0; dx < 2; dx++) {
                const p = ivec2(min(x.mul(2).add(dx), W.sub(1)), min(y.mul(2).add(dy), H.sub(1)));
                for (let k = 0; k < samples; k++) m.assign(max(m, textureLoad(depthTexture, p, int(k)).x));
              }
          } else {
            const pl = h.levels.element(L - 1);
            const po = uint(pl.x), pw = uint(pl.y), ph = uint(pl.z);
            for (let dy = 0; dy < 2; dy++)
              for (let dx = 0; dx < 2; dx++) {
                const cx = min(x.mul(2).add(dx), pw.sub(1)), cy = min(y.mul(2).add(dy), ph.sub(1));
                m.assign(max(m, h.buf.element(po.add(cy.mul(pw)).add(cx))));
              }
          }
          h.buf.element(uint(lv.x).add(y.mul(w)).add(x)).assign(m);
        });
      })().compute(HZB_LEVEL0_MAX, [WG]);
      h.passes.push(node);
    }
    this.hzbReady = true;
  }

  /** Phase 2 (main view): build the HZB from the phase 1 depth, then cull set B against it. */
  occlusion(camera, width, height) {
    if (this.frozen || !this.hzbReady || this.u.occlusion.value === 0) return;
    const h = this.hzb;
    let w = Math.ceil(width / 2), hh = Math.ceil(height / 2), off = 0, n = 0;
    if (w * hh > HZB_LEVEL0_MAX) return; // (a huge screen: phase 1 only)
    const counts = [];
    while (n < HZB_LEVELS) {
      h.levels.array[n].set(off, w, hh, 0);
      counts.push(w * hh);
      off += w * hh;
      n++;
      if (w === 1 && hh === 1) break;
      w = Math.ceil(w / 2);
      hh = Math.ceil(hh / 2);
    }
    h.count.value = n;
    h.size.value.set(width, height);
    h.view.value.copy(camera.matrixWorldInverse);
    const e = camera.projectionMatrix.elements;
    h.proj.value.set(e[0], e[5], e[10], e[14]);
    h.near.value = camera.near;
    const r = this.renderer;
    for (let L = 0; L < n; L++) r.compute(h.passes[L], counts[L]);
    const v = this.main, setB = v.sets[1];
    r.compute(v.retestArgs);
    r.compute(v.retestTreesPass, v.retestTreeDispatch);
    r.compute(v.retestClustersPass, v.retestClusterDispatch);
    r.compute(setB.clampDispatch);
    r.compute(setB.clusters, setB.dispatchAttr);
    r.compute(setB.clampDraw);
    setB.ran = true;
  }

  // ------------------------------------------------------------------ draw
  /**
   * Vertex k (its slot in the cluster's index list) of cluster c of tree inst: planet-curved world position (with
   * wind), normal (tree rotation only) and uv. `leaf`: true / false, or a bool node when it's only known per cluster.
   */
  _vertex(inst, c, k, leaf) {
    const u = this.u;
    const m = this.cMeta.element(c);
    const vi = this.idx.element(m.x.add(k));
    const va = this.vA.element(vi), vb = this.vB.element(vi);
    const a = this.instA.element(inst), b = this.instB.element(inst);
    const type = uint(b.z);
    const ti = this.typeInfo.element(type);
    const s = a.w;
    const rot = (v) => vec3(v.x.mul(b.x).sub(v.z.mul(b.y)), v.y, v.x.mul(b.y).add(v.z.mul(b.x)));
    const p = rot(va.xyz).mul(s);
    // wind: whole tree bends with height^2, leaves flutter on top
    const h = clamp(va.y.div(ti.w), 0, 1);
    const t = u.time.mul(1.1).add(b.w);
    const gust = sin(t.add(a.x.mul(0.013))).mul(0.6).add(sin(t.mul(2.7).add(a.z.mul(0.021))).mul(0.25)).add(0.35);
    const bend = h.mul(h).mul(gust).mul(u.wind).mul(0.06).mul(ti.w).mul(s);
    let off = vec3(bend.mul(0.8), bend.mul(-0.15), bend.mul(0.6));
    if (leaf !== false) {
      const ph = dot(va.xyz, vec3(1.7, 2.3, 1.1));
      const fl = sin(u.time.mul(7.0).add(ph)).mul(0.04).mul(u.wind).mul(s);
      const flutter = vec3(fl, fl.mul(0.5), fl.mul(-0.7));
      off = off.add(leaf === true ? flutter : select(leaf, flutter, vec3(0)));
    }
    return { world: curve(a.xyz.add(p).add(off)), normal: rot(vb.xyz), uv: vec2(va.w, vb.w), type };
  }

  /** Share of tree inst drawn as geometry (1, or less in the impostor cross-fade band): by its projected height. */
  _geometryShare(inst, view = this.main) {
    const u = this.u;
    const a = this.instA.element(inst), b = this.instB.element(inst);
    const ti = this.typeInfo.element(uint(b.z));
    const dCam = length(a.xyz.add(vec3(0, ti.w.mul(0.5).mul(a.w), 0)).sub(view.lodPos));
    const px = ti.w.mul(a.w).mul(u.projScale).div(max(dCam, 0.1)); // (same as the instance pass)
    return smoothstep(u.impostorPx, u.impostorPx.mul(FADE_HI), px);
  }

  /**
   * Debug colours: 1 = cluster, 2 = DAG level, 3 = tree instance, 4 = tree type (unlit, see TYPE_IDS),
   * 5 = rasterizer (hardware grey-green; the software rasterizer's pixels are magenta, see softraster.js).
   */
  _debugColour(inst, c, type) {
    const u = this.u;
    const level = this.cMeta.element(c).z;
    const dbgSeed = select(u.debug.equal(1), c, select(u.debug.equal(2), level.mul(7919).add(3), inst));
    const palette = vec3(hash(dbgSeed), hash(dbgSeed.add(17)), hash(dbgSeed.add(43)));
    const levelRamp = mix(vec3(0.1, 0.9, 0.2), vec3(1.0, 0.15, 0.1), clamp(float(level).div(8), 0, 1));
    return select(u.debug.equal(5), vec3(0.25, 0.4, 0.25), select(u.debug.equal(4), typeId(type), select(u.debug.equal(2), levelRamp, palette)));
  }

  _buildMesh(kind, view, set, shadowOnly) {
    const u = this.u;
    const textures = this.textures;
    const list = storage(kind === 0 ? set.barkListAttr : set.leafListAttr, 'uvec2', LIST_CAP).toReadOnly();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRIS * 3 * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX_TRIS * 3 * 3), 3));
    geo.setIndirect(kind === 0 ? set.barkArgsAttr : set.leafArgsAttr);

    const vUv = varying(vec2(0), 'vUv');
    const vLayer = varying(float(0), 'vLayer');
    const vDebug = varying(vec3(0), 'vDebug');
    const vTint = varying(float(1), 'vTint');
    const vFade = varying(float(1), 'vFade'); // share of this tree drawn as geometry (impostor cross-fade)

    const position = Fn(() => {
      const entry = list.element(instanceIndex);
      const inst = entry.x, c = entry.y;
      const m = this.cMeta.element(c);
      const valid = vertexIndex.div(3).lessThan(m.y);
      const vx = this._vertex(inst, c, min(vertexIndex, m.y.mul(3).sub(1)), kind === 1);
      const type = vx.type;
      normalLocal.assign(vx.normal);
      vUv.assign(vx.uv);
      const layer = kind === 0 ? textures.barkLayerOf : textures.leafLayerOf;
      vLayer.assign(layer(type));
      if (!shadowOnly) {
        vFade.assign(this._geometryShare(inst, view));
        vTint.assign(treeTint(inst));
        vDebug.assign(this._debugColour(inst, c, type));
      }
      return select(valid, vx.world, vec3(0));
    })();

    const leafAlpha = makeLeafAlpha(textures.leaf, vUv);
    // the layer index must be exact: an interpolated 2.9999 truncates to the wrong texture (aspen speckles on pines,
    // shimmering from frame to frame)
    const layerI = vLayer.round();
    let mat;
    if (shadowOnly) {
      // depth-only caster: just the alpha cut-out for leaves
      mat = new THREE.MeshBasicNodeMaterial({ side: kind === 1 ? THREE.DoubleSide : THREE.FrontSide, alphaTest: kind === 1 ? 0.5 : 0 });
      if (kind === 1) mat.colorNode = vec4(1, 1, 1, leafAlpha(texture(textures.leaf, vUv).depth(layerI).a, layerI));
    } else if (kind === 0) {
      mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, alphaTest: 0.5 });
      const col = barkColour(texture(textures.bark, vUv).depth(layerI).rgb);
      mat.colorNode = vec4(select(u.debug.equal(4), vec3(0), select(u.debug.greaterThan(0), vDebug, col)), select(dither().lessThan(vFade), float(1), float(0)));
      mat.emissiveNode = select(u.debug.equal(4), vDebug, vec3(0));
    } else {
      // Lambert: no specular sheen on leaves, and cheaper for the heavy foliage overdraw
      mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
      mat.alphaToCoverage = textures.alphaToCoverage; // with MSAA: smooth cut-outs instead of sparkling leaves
      const tex = texture(textures.leaf, vUv).depth(layerI);
      const alpha = leafAlpha(tex.a, layerI);
      const col = leafColour(tex.rgb, layerI, vTint);
      mat.colorNode = vec4(select(u.debug.equal(4), vec3(0), select(u.debug.greaterThan(0), vDebug, col)), select(dither().lessThan(vFade), alpha, float(0)));
      // keep the outward crown normal on both faces (default flips it on back faces => black leaves)
      mat.normalNode = normalViewGeometry;
      // light passing through leaves
      mat.emissiveNode = select(u.debug.equal(4), vDebug, select(u.debug.greaterThan(0), vec3(0), col.mul(0.12)));
    }
    mat.positionNode = position;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    if (shadowOnly) {
      mesh.castShadow = true;
      mesh.layers.set(1); // only the shadow camera renders these
    } else {
      mesh.receiveShadow = true;
    }
    mesh.name = `nanite-${kind === 0 ? 'bark' : 'leaves'}-${view.name}`;
    return mesh;
  }

  // ------------------------------------------------------------------ impostors (far field)
  /** atlas: { texture, frames: [{w, h}], renderTarget, coverage } from bakeImpostors + impostorCoverage: per tree type a side tile and a top-down tile. */
  /** `gains`: per tree type, { side: [r, g, b], top: [r, g, b] } colour gains (VARIANTS[i].impGain). */
  buildImpostorMesh(atlas, gains) {
    const u = this.u;
    const v = this.main;
    const flags = storage(v.impFlagAttr, 'uint', this.instanceCount).toReadOnly();
    const n = atlas.frames.length;
    const frameW = uniformArray(atlas.frames.map((f) => f.w), 'float');
    const frameH = uniformArray(atlas.frames.map((f) => f.h), 'float');
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    // one instance per tree; trees not flagged as impostors this frame collapse to a point
    geo.setIndirect(new THREE.IndirectStorageBufferAttribute(new Uint32Array([6, this.instanceCount, 0, 0]), 4));
    const vUv = varying(vec2(0), 'vImpUv');
    const vTint = varying(float(1), 'vImpTint');
    const vTop = varying(float(0), 'vImpTop');
    const vType = varying(float(0), 'vImpType');
    const vFade = varying(float(0), 'vImpFade'); // share drawn as geometry (cross-fade band)
    const vRight = varying(vec3(1, 0, 0), 'vImpRight'); // billboard basis (right incl. mirroring), for the normals
    const vUp = varying(vec3(0, 1, 0), 'vImpUp');
    const vDir = varying(vec3(0, 0, 1), 'vImpDir');
    const position = Fn(() => {
      const inst = instanceIndex;
      const on = flags.element(inst).equal(1).toVar();
      const a = this.instA.element(inst), b = this.instB.element(inst);
      const type = uint(b.z);
      const ti = this.typeInfo.element(type);
      const s = a.w;
      // corners of a quad, two triangles: (0,0) (1,0) (1,1) / (0,0) (1,1) (0,1)
      const vi = vertexIndex;
      const cx = select(vi.equal(1).or(vi.equal(2)).or(vi.equal(4)), float(1), float(0));
      const cy = select(vi.equal(2).or(vi.equal(4)).or(vi.equal(5)), float(1), float(0));
      // billboard facing the camera, pivoting about the frame's centre: upright when seen from the side (base on
      // the ground), lying flat when seen from above, where it shows the top-down tile instead (a cylindrical
      // billboard would be seen edge-on from above, leaving a bald patch under the camera)
      const h0 = frameH.element(type).mul(s);
      const pivot = a.xyz.add(vec3(0, h0.mul(0.5), 0));
      const dist = length(u.camPos.sub(pivot));
      const dir = u.camPos.sub(pivot).div(max(dist, 1e-3));
      // seen from above, the coarse cluster LODs it replaces read wider than the full-detail crown in the atlas
      // (fewer, grown leaf cards): enlarge the top view to match, so the forest doesn't thin out at the switch
      const top = smoothstep(0.4, 0.8, dir.y);
      const grow = mix(float(1), float(TOP_GROW), top).toVar();
      // sub-pixel trees shimmer (they hit or miss pixel centres as the camera moves): never draw a quad narrower
      // than MIN_PX; keep the forest's coverage by dropping a matching share of the trees instead (per tree, so
      // there's no flicker, only a rare tree fading out as you climb)
      const wPx = frameW.element(type).mul(s).mul(grow).mul(u.projScale).div(max(dist, 0.1));
      const small = wPx.lessThan(MIN_PX);
      If(small, () => {
        on.assign(on.and(hash(inst.add(7)).lessThan(wPx.div(MIN_PX))));
        grow.mulAssign(float(MIN_PX).div(max(wPx, 1e-3)));
      });
      const w = frameW.element(type).mul(s).mul(grow), h = h0.mul(grow);
      const right = vec3(dir.z, 0, dir.x.negate()).add(vec3(1e-4, 0, 0)).normalize();
      const up = cross(dir, right);
      const flip = hash(inst).greaterThan(0.5); // mirror half of them for variety
      const ux = select(flip, cx.oneMinus(), cx);
      vUv.assign(vec2(float(type).add(ux).div(2 * n), cy.oneMinus())); // (render-target textures are stored flipped)
      vTop.assign(top);
      vType.assign(float(type));
      vTint.assign(treeTint(inst));
      vRight.assign(select(flip, right.negate(), right));
      vUp.assign(up);
      vDir.assign(dir);
      // same projected height as the instance pass (geometry share of the cross-fade)
      const dCam = length(a.xyz.add(vec3(0, ti.w.mul(0.5).mul(s), 0)).sub(v.lodPos));
      const px = ti.w.mul(s).mul(u.projScale).div(max(dCam, 0.1));
      vFade.assign(smoothstep(u.impostorPx, u.impostorPx.mul(FADE_HI), px));
      normalLocal.assign(dir);
      const p = pivot.add(right.mul(cx.sub(0.5).mul(w))).add(up.mul(cy.sub(0.5).mul(h)));
      return select(on, curve(p), vec3(0));
    })();
    // lit like the real leaves (Lambert, same lights, shadow fade and fog), from baked albedo + normals
    const mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: IMPOSTOR_CUT });
    mat.alphaToCoverage = this.textures.alphaToCoverage;
    // side tiles are the atlas's left half, top-down tiles the right half
    const uvTop = vUv.add(vec2(0.5, 0));
    const tSide = texture(atlas.texture, vUv), tTop = texture(atlas.texture, uvTop);
    const nSide = texture(atlas.normals, vUv), nTop = texture(atlas.normals, uvTop);
    // coverage-preserving alpha by the sampled mip (see impostorCoverage)
    const { scales, levels } = atlas.coverage;
    const scaleArr = uniformArray(Array.from(scales), 'float');
    const texel = vUv.mul(vec2(atlas.renderTarget.width, atlas.renderTarget.height));
    const lod = clamp(log2(max(length(dFdx(texel)), length(dFdy(texel)))), 0, levels - 1.001);
    const scaleOf = (tile) => {
      const i0 = tile.mul(levels).add(uint(lod.floor()));
      return mix(scaleArr.element(i0), scaleArr.element(i0.add(1)), lod.fract());
    };
    const tile = uint(vType.round());
    // cross-fade side -> top as the union of both silhouettes (mixing their alphas would keep only the overlap and
    // thin the forest out at mid elevations), colour weighted by each one's share
    const aSide = tSide.a.mul(scaleOf(tile)).mul(clamp(vTop.oneMinus().mul(2), 0, 1));
    const aTop = tTop.a.mul(scaleOf(tile.add(n))).mul(clamp(vTop.mul(2), 0, 1));
    const wSum = max(aSide.add(aTop), 1e-4);
    // (MSAA-resolved edges are premultiplied by coverage: divide it out)
    const albedo = tSide.rgb.div(max(tSide.a, 1e-3)).mul(aSide).add(tTop.rgb.div(max(tTop.a, 1e-3)).mul(aTop)).div(wSum);
    // tree-local normals to world: the side tile looks along -z (right +x, up +y), the top one down (right +x, up -z)
    const ns = nSide.xyz, nt = nTop.xyz;
    const nWorld = vRight.mul(ns.x).add(vUp.mul(ns.y)).add(vDir.mul(ns.z)).mul(aSide)
      .add(vRight.mul(nt.x).add(vUp.mul(nt.z.negate())).add(vDir.mul(nt.y)).mul(aTop));
    mat.normalNode = normalize(cameraViewMatrix.mul(vec4(nWorld.add(vDir.mul(1e-3)), 0)).xyz);
    // (the gains: measured against the real trees; partly the sub-pixel leaves of the real trees, which blend with
    // what's behind them and read paler than the solid baked crowns)
    const gainSide = uniformArray(gains.map((g) => new THREE.Vector3(...g.side).multiply(new THREE.Vector3(...IMP_GAIN))), 'vec3');
    const gainTop = uniformArray(gains.map((g) => new THREE.Vector3(...g.top).multiply(new THREE.Vector3(...IMP_GAIN_TOP))), 'vec3');
    this.impGains = { side: gainSide, top: gainTop }; // (live: harness --typematch=calibrate adjusts them)
    const gain = mix(gainSide.element(tile), gainTop.element(tile), aTop.div(wSum));
    const col = albedo.mul(vec3(vTint.mul(0.92), vTint, vTint.mul(0.8))).mul(gain);
    // the other half of the geometry's dithered cross-fade
    const alpha = select(dither().lessThan(vFade), float(0), min(max(aSide, aTop), 1));
    mat.colorNode = vec4(select(u.debug.greaterThan(0), vec3(0), col), alpha);
    mat.emissiveNode = select(u.debug.equal(4), typeId(tile), select(u.debug.greaterThan(0), vec3(0.9, 0.2, 0.8), col.mul(0.12)));
    mat.positionNode = position;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.name = 'nanite-impostors';
    // drawn in phase 2, after occlusion() has dropped the hidden ones (with occlusion off, all flagged ones)
    mesh.layers.set(PHASE2_LAYER);
    return mesh;
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
    if (shadowCamera) this._cull(this.shadow, shadowCamera);
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
