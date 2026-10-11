// NaniteForest methods: the cluster meshes (vertex pulling from the draw lists) and their materials.
import * as THREE from 'three/webgpu';
import {
  Fn, storage, instanceIndex, vertexIndex, uint, float, vec2, vec3, vec4, uvec2, select, max, min, varying,
  normalLocal, texture, sin, mix, hash, length, dot, clamp, smoothstep, normalViewGeometry, mrt, cameraProjectionMatrix,
  cameraViewMatrix,
} from 'three/tsl';
import { curve } from '../planet.ts';
import { FADE_HI, MAX_TRIS, LIST_CAP, ARGS, minU } from './constants.ts';
import type { NaniteForest } from './forest.ts';
import type { Bool, Float, Uint, Vec3 } from '../types.ts';
import type { ClusterVertex, CullSet, View } from './types.ts';
import { setEmissive } from '../three-gaps.ts';
import { autumnOf } from '../autumn.ts';
import { makeLeafAlpha, a2cDither, leafColour, barkColour, treeTint, dither, typeId, switchPx } from './shading.ts';

export const drawMethods = {
  // ------------------------------------------------------------------ draw
  /**
   * Vertex k (its slot in the cluster's index list) of cluster c of tree inst: planet-curved world position (with
   * wind), normal (tree rotation only) and uv. `leaf`: true / false, or a bool node when it's only known per cluster.
   * `prevWorld`: the same with last frame's wind (for the wind motion vectors of temporal anti-aliasing).
   */
  _vertex(this: NaniteForest, inst: Uint, c: Uint, k: Uint, leaf: boolean | Bool): ClusterVertex {
    const u = this.u;
    const m = this._meta(c);
    const vi = this.idx.element(m.x.add(k));
    const va = this._vtx(vi, 0), vb = this._vtx(vi, 1);
    const a = this._a(inst), b = this._b(inst);
    const type = uint(b.z);
    const ti = this.typeInfo.element(type);
    const s = a.w;
    const rot = (v: Vec3): Vec3 => vec3(v.x.mul(b.x).sub(v.z.mul(b.y)), v.y, v.x.mul(b.y).add(v.z.mul(b.x)));
    const p = rot(va.xyz).mul(s);
    // wind: whole tree bends with height^2, leaves flutter on top
    const h = clamp(va.y.div(ti.w), 0, 1);
    const windAt = (time: Float): Vec3 => {
      const t = time.mul(1.1).add(b.w);
      const gust = sin(t.add(a.x.mul(0.013))).mul(0.6).add(sin(t.mul(2.7).add(a.z.mul(0.021))).mul(0.25)).add(0.35);
      const sway = u.wind.mul(this.windOf.element(type)); // (0 for models)
      const bend = h.mul(h).mul(gust).mul(sway).mul(0.06).mul(ti.w).mul(s);
      let off: Vec3 = vec3(bend.mul(0.8), bend.mul(-0.15), bend.mul(0.6));
      if (leaf !== false) {
        const ph = dot(va.xyz, vec3(1.7, 2.3, 1.1));
        const fl = sin(time.mul(7.0).add(ph)).mul(0.04).mul(sway).mul(s);
        const flutter = vec3(fl, fl.mul(0.5), fl.mul(-0.7));
        off = off.add(leaf === true ? flutter : select(leaf, flutter, vec3(0)));
      }
      return off;
    };
    const base = a.xyz.add(p);
    return {
      world: curve(base.add(windAt(u.time))),
      prevWorld: curve(base.add(windAt(u.prevTime))),
      normal: rot(vb.xyz), uv: vec2(va.w, vb.w), type,
    };
  },

  /** Share of tree inst drawn as geometry (1, or less in the impostor cross-fade band): by its projected height. */
  _geometryShare(this: NaniteForest, inst: Uint, view?: View): Float {
    const u = this.u;
    const lodPos = (view ?? this.main).lodPos;
    const a = this._a(inst), b = this._b(inst);
    const ti = this.typeInfo.element(uint(b.z));
    const dCam = length(a.xyz.add(vec3(0, ti.w.mul(0.5).mul(a.w), 0)).sub(lodPos));
    const px = ti.w.mul(a.w).mul(u.projScale).div(max(dCam, 0.1)); // (same as the instance pass)
    const sw = switchPx(u, inst);
    return smoothstep(sw, sw.mul(FADE_HI), px);
  },

  /**
   * Debug colours: 1 = cluster, 2 = DAG level, 3 = tree instance, 4 = tree type (unlit, see TYPE_IDS),
   * 5 = rasterizer (hardware grey-green; the software rasterizer's pixels are orange, see softraster.js).
   */
  _debugColour(this: NaniteForest, inst: Uint, c: Uint, type: Uint): Vec3 {
    const u = this.u;
    const level = this._meta(c).z;
    const dbgSeed = select(u.debug.equal(1), c, select(u.debug.equal(2), level.mul(7919).add(3), inst));
    const palette = vec3(hash(dbgSeed), hash(dbgSeed.add(17)), hash(dbgSeed.add(43)));
    const levelRamp = mix(vec3(0.1, 0.9, 0.2), vec3(1.0, 0.15, 0.1), clamp(float(level).div(8), 0, 1));
    return select(u.debug.equal(5), vec3(0.25, 0.4, 0.25), select(u.debug.equal(4), typeId(type), select(u.debug.equal(2), levelRamp, palette)));
  },

  _buildMesh(this: NaniteForest, kind: 0 | 1, view: View, set: CullSet, shadowOnly: boolean): THREE.Mesh {
    const u = this.u;
    const textures = this.textures;
    const list = storage(set.listAttr, 'uvec2', LIST_CAP * 2).toReadOnly(); // (bark, then leaves)
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRIS * 3 * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX_TRIS * 3 * 3), 3));
    geo.setIndirect(set.ctr.attr, (set.base + (kind === 0 ? ARGS.bark : ARGS.leaf)) * 4); // (byte offset)

    const vUv = varying(vec2(0), 'vUv');
    const vLayer = varying(float(0), 'vLayer');
    const vDebug = varying(vec3(0), 'vDebug');
    const vTint = varying(float(1), 'vTint');
    const vAutumn = varying(float(0), 'vAutumn');
    const vFade = varying(float(1), 'vFade'); // share of this tree drawn as geometry (impostor cross-fade)
    // clip positions with this and last frame's wind (same camera): the wind's motion on screen, for TAA
    const vClip = varying(vec4(0, 0, 0, 1), 'vClip'), vPrevClip = varying(vec4(0, 0, 0, 1), 'vPrevClip');

    const position = Fn(() => {
      const entry = list.element(kind === 0 ? instanceIndex : instanceIndex.add(LIST_CAP));
      const inst = entry.x, c = entry.y;
      const m = this._meta(c);
      const valid = vertexIndex.div(3).lessThan(m.y);
      const vx = this._vertex(inst, c, minU(vertexIndex, m.y.mul(3).sub(1)), kind === 1);
      const type = vx.type;
      normalLocal.assign(vx.normal);
      vUv.assign(vx.uv);
      const layer = kind === 0 ? textures.barkLayerOf : textures.leafLayerOf;
      vLayer.assign(layer(type));
      if (!shadowOnly) {
        vFade.assign(this._geometryShare(inst, view));
        vTint.assign(treeTint(inst));
        vAutumn.assign(autumnOf(this._b(inst).w));
        vDebug.assign(this._debugColour(inst, c, type));
        const viewProj = cameraProjectionMatrix.mul(cameraViewMatrix);
        vClip.assign(viewProj.mul(vec4(vx.world, 1)));
        vPrevClip.assign(viewProj.mul(vec4(vx.prevWorld, 1)));
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
      // (without MSAA, under TAA: alpha to coverage against a moving dither, see a2cDither)
      const alpha = textures.leafDither ? a2cDither(leafAlpha(tex.a, layerI)) : leafAlpha(tex.a, layerI);
      const col = leafColour(tex.rgb, layerI, vTint, vAutumn);
      mat.colorNode = vec4(select(u.debug.equal(4), vec3(0), select(u.debug.greaterThan(0), vDebug, col)), select(dither().lessThan(vFade), alpha, float(0)));
      // keep the outward crown normal on both faces (default flips it on back faces => black leaves)
      mat.normalNode = normalViewGeometry;
      // light passing through leaves
      setEmissive(mat, select(u.debug.equal(4), vDebug, select(u.debug.greaterThan(0), vec3(0), col.mul(0.12))));
    }
    mat.positionNode = position;
    if (!shadowOnly) {
      // (uv units, y down: what the TAA resolve subtracts from its camera reprojection; see src/taa.js)
      const motion = vClip.xy.div(vClip.w).sub(vPrevClip.xy.div(vPrevClip.w)).mul(vec2(0.5, -0.5));
      mat.mrtNode = mrt({ wind: vec4(motion, 0, 1) });
    }
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
  },
};
