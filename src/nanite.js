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
//                 triangles from storage buffers (128 tris max, the rest degenerate)
// Steps 1-3 run twice: for the camera, and for the sun's shadow map (its own frustum, coarser LOD). The shadow
// meshes live on layer 1, which only the shadow camera sees.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, storage, uniform, uniformArray, instanceIndex, vertexIndex, workgroupId, localId, numWorkgroups,
  uint, float, vec2, vec3, vec4, uvec2, atomicAdd, atomicStore, select, max, min, varying, normalLocal, texture,
  sin, mix, hash, length, dot, clamp, smoothstep, dFdx, dFdy, log2, normalViewGeometry, cross, fract, screenCoordinate,
  cameraViewMatrix, normalize,
} from 'three/tsl';
import { curve } from './planet.js';
import { IMPOSTOR_CUT } from './impostors.js';

/**
 * Coverage-preserving alpha for the leaf array texture (see coverageScales in main.js): scales alpha by the
 * precomputed factor of the mip level being sampled, so cut-out leaves keep their density at any size.
 */
export function makeLeafAlpha(leafTex, uvNode) {
  const levels = leafTex.userData.levels;
  const scaleArr = uniformArray(leafTex.userData.alphaScales, 'float');
  return (a, layer) => {
    const lod = clamp(log2(max(length(dFdx(uvNode)), length(dFdy(uvNode))).mul(leafTex.image.width)), 0, levels - 1.001);
    const i0 = uint(layer).mul(levels).add(uint(lod.floor()));
    return a.mul(mix(scaleArr.element(i0), scaleArr.element(i0.add(1)), lod.fract()));
  };
}

/** Screen-space dither in [0, 1) (interleaved gradient noise): a fixed pattern, so a cross-fade doesn't shimmer. */
const dither = () => fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)).fract().mul(52.9829189));

function countFlags(buf) {
  const f = new Uint32Array(buf);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i];
  return n;
}

const TOP_GROW = Number(new URLSearchParams(location.search).get('topgrow') ?? 1.25);
const IMP_GAIN = (new URLSearchParams(location.search).get('impgain') ?? '1.4,1.3,1.8').split(',').map(Number);
const MIN_PX = 2; // impostors are never drawn narrower than this (pixels)
const FADE_HI = 1.3; // impostor cross-fade band: [1, FADE_HI] x impostorPx (geometry count unchanged)
const SHADOW_TAU_MUL = 2.5; // shadow casters may be coarser than what's seen
const MAX_TRIS = 128;
const WG = 64;
const MAX_ITEMS = 1 << 20; // max 64-cluster work items per view (dispatched 2D: 65535 workgroups per dimension)
const MAX_DIM = 65535;
const LIST_CAP = 1 << 20; // max visible clusters per list

export class NaniteForest {
  constructor(renderer, trees, instances, textures) {
    this.renderer = renderer;
    this.frozen = false;
    this.u = {
      camPos: uniform(new THREE.Vector3()), // LOD is always computed from the camera, also for the shadow view
      projScale: uniform(1000),
      tau: uniform(1.0), // max screen-space error in pixels
      maxDist: uniform(3000),
      impostorPx: uniform(14), // trees drawn shorter than this (pixels) become impostor quads
      time: uniform(0),
      wind: uniform(1),
      debug: uniform(0, 'uint'),
    };
    this.textures = textures;
    this._buildBuffers(trees, instances);
    this.main = this._buildView('main', 1);
    this.shadow = this._buildView('shadow', SHADOW_TAU_MUL);
    this.group = new THREE.Group();
    for (const kind of [0, 1]) {
      this.group.add(this._buildMesh(kind, this.main, false));
      this.group.add(this._buildMesh(kind, this.shadow, true));
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
  _buildView(name, tauMul) {
    const u = this.u;
    const sb = (arr, item) => new THREE.StorageBufferAttribute(arr, item);
    const v = {
      name,
      planes: uniformArray(Array.from({ length: 6 }, () => new THREE.Vector4()), 'vec4'),
      tauMul: uniform(tauMul),
      lodPos: uniform(new THREE.Vector3()), // where LOD is measured from: the camera (+ a debug shift)
      lodShift: new THREE.Vector3(),
      itemsAttr: sb(new Uint32Array(MAX_ITEMS * 2), 2),
      dispatchAttr: new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4),
      barkArgsAttr: new THREE.IndirectStorageBufferAttribute(new Uint32Array([MAX_TRIS * 3, 0, 0, 0]), 4),
      leafArgsAttr: new THREE.IndirectStorageBufferAttribute(new Uint32Array([MAX_TRIS * 3, 0, 0, 0]), 4),
      statsAttr: sb(new Uint32Array(4), 1),
      itemCountAttr: sb(new Uint32Array(1), 1),
      // per tree: drawn as an impostor this frame? (a flag per tree instead of an appended list: 900k threads
      // appending through one atomic counter took ~5 ms; the impostor draw covers every tree and the vertex shader
      // collapses the unflagged ones, which is far cheaper)
      impFlagAttr: sb(new Uint32Array(name === 'main' ? this.instanceCount : 1), 1),
      barkListAttr: sb(new Uint32Array(LIST_CAP * 2), 2),
      leafListAttr: sb(new Uint32Array(LIST_CAP * 2), 2),
    };
    const tau = u.tau.mul(v.tauMul);
    const items = storage(v.itemsAttr, 'uvec2', MAX_ITEMS);
    const dispatchA = storage(v.dispatchAttr, 'uint', 4).toAtomic();
    const barkA = storage(v.barkArgsAttr, 'uint', 4).toAtomic();
    const leafA = storage(v.leafArgsAttr, 'uint', 4).toAtomic();
    const statsA = storage(v.statsAttr, 'uint', 4).toAtomic();
    const impFlag = storage(v.impFlagAttr, 'uint', name === 'main' ? this.instanceCount : 1);
    const barkList = storage(v.barkListAttr, 'uvec2', LIST_CAP);
    const leafList = storage(v.leafListAttr, 'uvec2', LIST_CAP);

    const sphereVisible = (c, r) => {
      const vis = uint(1).toVar();
      for (let p = 0; p < 6; p++) {
        const pl = v.planes.element(p);
        If(dot(pl.xyz, c).add(pl.w).lessThan(r.negate()), () => vis.assign(0));
      }
      return vis.equal(1);
    };
    const rotY = (p, cs, sn) => vec3(p.x.mul(cs).sub(p.z.mul(sn)), p.y, p.x.mul(sn).add(p.z.mul(cs)));

    v.reset = Fn(() => {
      atomicStore(dispatchA.element(0), uint(0));
      atomicStore(barkA.element(1), uint(0));
      atomicStore(leafA.element(1), uint(0));
      for (let i = 0; i < 3; i++) atomicStore(statsA.element(i), uint(0));
    })().compute(1, [1]);

    v.instances = Fn(() => {
      const i = instanceIndex;
      const a = this.instA.element(i);
      const b = this.instB.element(i);
      const ti = this.typeInfo.element(uint(b.z));
      const s = a.w;
      const center = a.xyz.add(vec3(0, ti.w.mul(0.5).mul(s), 0));
      const centerC = curve(center); // where the planet's curvature puts it on screen
      const r = ti.z.mul(s);
      const dCam = length(center.sub(v.lodPos));
      const px = ti.w.mul(s).mul(u.projScale).div(max(dCam, 0.1)); // projected tree height
      // between 1 x and FADE_HI x the impostor threshold a tree is drawn both ways, dithered (see dither)
      const far = px.lessThan(u.impostorPx);
      const visible = sphereVisible(centerC, r).and(dCam.sub(r).lessThan(u.maxDist)).toVar();
      // (impostors cast no shadow: receivers fall back to an average shadow there, see main.js)
      if (name === 'main') impFlag.element(i).assign(select(visible.and(px.lessThan(u.impostorPx.mul(FADE_HI))), uint(1), uint(0)));
      If(visible.and(far.not()), () => {
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
        atomicAdd(statsA.element(2), uint(1));
        Loop({ start: uint(0), end: nItems, type: 'uint', condition: '<' }, ({ i: k }) => {
          If(base.add(k).lessThan(MAX_ITEMS), () => {
            items.element(base.add(k)).assign(uvec2(i, k.mul(WG).bitOr(n.shiftLeft(16))));
          });
        });
      });
    })().compute(this.instanceCount, [WG]);

    // turn the item count into a 2D dispatch; the cluster pass gets the count from a separate buffer (a buffer can't
    // be both the indirect args and a storage binding of the same dispatch)
    const dispatchRW = storage(v.dispatchAttr, 'uint', 4);
    const itemCountW = storage(v.itemCountAttr, 'uint', 1);
    v.clampDispatch = Fn(() => {
      const total = min(dispatchRW.element(0), uint(MAX_ITEMS)).toVar();
      itemCountW.element(0).assign(total);
      dispatchRW.element(0).assign(min(total, uint(MAX_DIM)));
      dispatchRW.element(1).assign(total.add(MAX_DIM - 1).div(MAX_DIM));
    })().compute(1, [1]);

    const itemCount = storage(v.itemCountAttr, 'uint', 1).toReadOnly();
    v.clusters = Fn(() => {
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
          const cw = a.xyz.add(rotY(cs.xyz, b.x, b.y).mul(s));
          If(sphereVisible(curve(cw), cs.w.mul(s)), () => {
            const tris = this.cMeta.element(c).y;
            If(e.w.lessThan(0.5), () => {
              const slot = atomicAdd(barkA.element(1), uint(1)).toVar();
              atomicAdd(statsA.element(0), tris);
              If(slot.lessThan(LIST_CAP), () => barkList.element(slot).assign(uvec2(inst, c)));
            }).Else(() => {
              const slot = atomicAdd(leafA.element(1), uint(1)).toVar();
              atomicAdd(statsA.element(1), tris);
              If(slot.lessThan(LIST_CAP), () => leafList.element(slot).assign(uvec2(inst, c)));
            });
          });
        });
      });
    })().compute(MAX_ITEMS * WG, [WG]);

    const barkRW = storage(v.barkArgsAttr, 'uint', 4);
    const leafRW = storage(v.leafArgsAttr, 'uint', 4);
    v.clampDraw = Fn(() => {
      barkRW.element(1).assign(min(barkRW.element(1), uint(LIST_CAP)));
      leafRW.element(1).assign(min(leafRW.element(1), uint(LIST_CAP)));
    })().compute(1, [1]);

    return v;
  }

  // ------------------------------------------------------------------ draw
  _buildMesh(kind, view, shadowOnly) {
    const u = this.u;
    const textures = this.textures;
    const list = storage(kind === 0 ? view.barkListAttr : view.leafListAttr, 'uvec2', LIST_CAP).toReadOnly();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRIS * 3 * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX_TRIS * 3 * 3), 3));
    geo.setIndirect(kind === 0 ? view.barkArgsAttr : view.leafArgsAttr);

    const vUv = varying(vec2(0), 'vUv');
    const vLayer = varying(float(0), 'vLayer');
    const vDebug = varying(vec3(0), 'vDebug');
    const vTint = varying(float(1), 'vTint');
    const vFade = varying(float(1), 'vFade'); // share of this tree drawn as geometry (impostor cross-fade)

    const position = Fn(() => {
      const entry = list.element(instanceIndex);
      const inst = entry.x, c = entry.y;
      const m = this.cMeta.element(c);
      const tri = vertexIndex.div(3);
      const valid = tri.lessThan(m.y);
      const vi = this.idx.element(m.x.add(min(vertexIndex, m.y.mul(3).sub(1))));
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
      const off = vec3(bend.mul(0.8), bend.mul(-0.15), bend.mul(0.6)).toVar();
      if (kind === 1) {
        const ph = dot(va.xyz, vec3(1.7, 2.3, 1.1));
        const fl = sin(u.time.mul(7.0).add(ph)).mul(0.04).mul(u.wind).mul(s);
        off.addAssign(vec3(fl, fl.mul(0.5), fl.mul(-0.7)));
      }
      const world = a.xyz.add(p).add(off);
      normalLocal.assign(rot(vb.xyz));
      vUv.assign(vec2(va.w, vb.w));
      const layer = kind === 0 ? textures.barkLayerOf : textures.leafLayerOf;
      vLayer.assign(layer(type));
      if (!shadowOnly) {
        // same projected height as the instance pass
        const dCam = length(a.xyz.add(vec3(0, ti.w.mul(0.5).mul(s), 0)).sub(view.lodPos));
        const px = ti.w.mul(s).mul(u.projScale).div(max(dCam, 0.1));
        vFade.assign(smoothstep(u.impostorPx, u.impostorPx.mul(FADE_HI), px));
        vTint.assign(hash(inst).mul(0.35).add(0.8));
        // debug colours: 1 = cluster, 2 = DAG level, 3 = tree instance
        const dbgSeed = select(u.debug.equal(1), c, select(u.debug.equal(2), m.z.mul(7919).add(3), inst));
        const palette = vec3(hash(dbgSeed), hash(dbgSeed.add(17)), hash(dbgSeed.add(43)));
        const levelRamp = mix(vec3(0.1, 0.9, 0.2), vec3(1.0, 0.15, 0.1), clamp(float(m.z).div(8), 0, 1));
        vDebug.assign(select(u.debug.equal(2), levelRamp, palette));
      }
      return select(valid, curve(world), vec3(0));
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
      const col = texture(textures.bark, vUv).depth(layerI).rgb.mul(vec3(0.9, 0.86, 0.8));
      mat.colorNode = vec4(select(u.debug.greaterThan(0), vDebug, col), select(dither().lessThan(vFade), float(1), float(0)));
    } else {
      // Lambert: no specular sheen on leaves, and cheaper for the heavy foliage overdraw
      mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
      mat.alphaToCoverage = textures.alphaToCoverage; // with MSAA: smooth cut-outs instead of sparkling leaves
      const tex = texture(textures.leaf, vUv).depth(layerI);
      const alpha = leafAlpha(tex.a, layerI);
      // per-tree hue variation; darker towards the bottom of the crown
      const inner = smoothstep(-0.6, 0.8, normalLocal.y).mul(0.4).add(0.6);
      // per-texture tint (layer 2 = aspen, an autumn-yellow texture: pull it back to summer green)
      // and layer 3 = pine, olive needles that read yellow in full sun: darker, bluer)
      const layerTint = select(
        layerI.equal(2),
        vec3(0.5, 0.82, 0.85),
        select(layerI.equal(3), vec3(0.62, 0.78, 1.0), vec3(1)),
      );
      const col = tex.rgb.mul(layerTint).mul(vec3(vTint.mul(0.92), vTint, vTint.mul(0.8))).mul(inner).mul(1.2);
      mat.colorNode = vec4(select(u.debug.greaterThan(0), vDebug, col), select(dither().lessThan(vFade), alpha, float(0)));
      // keep the outward crown normal on both faces (default flips it on back faces => black leaves)
      mat.normalNode = normalViewGeometry;
      // light passing through leaves
      mat.emissiveNode = select(u.debug.greaterThan(0), vec3(0), col.mul(0.12));
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
  buildImpostorMesh(atlas) {
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
      vTint.assign(hash(inst).mul(0.35).add(0.8));
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
    // (IMP_GAIN: measured against the real trees from above; partly the sub-pixel leaves of the real trees, which
    // blend with what's behind them and read paler than the solid baked crowns)
    const col = albedo.mul(vec3(vTint.mul(0.92), vTint, vTint.mul(0.8))).mul(vec3(...IMP_GAIN));
    // the other half of the geometry's dithered cross-fade
    const alpha = select(dither().lessThan(vFade), float(0), min(max(aSide, aTop), 1));
    mat.colorNode = vec4(select(u.debug.greaterThan(0), vec3(0), col), alpha);
    mat.emissiveNode = select(u.debug.greaterThan(0), vec3(0.9, 0.2, 0.8), col.mul(0.12));
    mat.positionNode = position;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.name = 'nanite-impostors';
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
    r.compute(view.reset);
    r.compute(view.instances);
    r.compute(view.clampDispatch);
    r.compute(view.clusters, view.dispatchAttr);
    r.compute(view.clampDraw);
  }

  /** Runs the GPU culling for the camera and (if given) the shadow camera. */
  update(camera, viewportHeight, time, shadowCamera = null) {
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
    this._cull(this.main, camera);
    if (shadowCamera) this._cull(this.shadow, shadowCamera);
  }

  /** Reads back the counters (async, for the overlay/harness). */
  async readStats(view = this.main) {
    if (!view.ran) return { barkClusters: 0, leafClusters: 0, barkTris: 0, leafTris: 0, instances: 0, items: 0, impostors: 0 };
    const [bark, leaf, st, disp, flags] = await Promise.all([
      this.renderer.getArrayBufferAsync(view.barkArgsAttr),
      this.renderer.getArrayBufferAsync(view.leafArgsAttr),
      this.renderer.getArrayBufferAsync(view.statsAttr),
      this.renderer.getArrayBufferAsync(view.itemCountAttr),
      view === this.main ? this.renderer.getArrayBufferAsync(view.impFlagAttr) : new ArrayBuffer(4),
    ]);
    const b = new Uint32Array(bark), l = new Uint32Array(leaf), s = new Uint32Array(st);
    return { barkClusters: b[1], leafClusters: l[1], barkTris: s[0], leafTris: s[1], instances: s[2], items: new Uint32Array(disp)[0], impostors: countFlags(flags) };
  }
}
