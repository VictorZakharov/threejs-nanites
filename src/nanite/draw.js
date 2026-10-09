// NaniteForest methods: the cluster meshes (vertex pulling from the draw lists) and their materials.
import * as THREE from 'three/webgpu';
import {
  Fn, storage, instanceIndex, vertexIndex, uint, float, vec2, vec3, vec4, uvec2, select, max, min, varying,
  normalLocal, texture, sin, mix, hash, length, dot, clamp, smoothstep, normalViewGeometry,
} from 'three/tsl';
import { curve } from '../planet.js';
import { FADE_HI, MAX_TRIS, LIST_CAP } from './constants.js';
import { makeLeafAlpha, leafColour, barkColour, treeTint, dither, typeId } from './shading.js';

export const drawMethods = {
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
  },

  /** Share of tree inst drawn as geometry (1, or less in the impostor cross-fade band): by its projected height. */
  _geometryShare(inst, view = this.main) {
    const u = this.u;
    const a = this.instA.element(inst), b = this.instB.element(inst);
    const ti = this.typeInfo.element(uint(b.z));
    const dCam = length(a.xyz.add(vec3(0, ti.w.mul(0.5).mul(a.w), 0)).sub(view.lodPos));
    const px = ti.w.mul(a.w).mul(u.projScale).div(max(dCam, 0.1)); // (same as the instance pass)
    return smoothstep(u.impostorPx, u.impostorPx.mul(FADE_HI), px);
  },

  /**
   * Debug colours: 1 = cluster, 2 = DAG level, 3 = tree instance, 4 = tree type (unlit, see TYPE_IDS),
   * 5 = rasterizer (hardware grey-green; the software rasterizer's pixels are orange, see softraster.js).
   */
  _debugColour(inst, c, type) {
    const u = this.u;
    const level = this.cMeta.element(c).z;
    const dbgSeed = select(u.debug.equal(1), c, select(u.debug.equal(2), level.mul(7919).add(3), inst));
    const palette = vec3(hash(dbgSeed), hash(dbgSeed.add(17)), hash(dbgSeed.add(43)));
    const levelRamp = mix(vec3(0.1, 0.9, 0.2), vec3(1.0, 0.15, 0.1), clamp(float(level).div(8), 0, 1));
    return select(u.debug.equal(5), vec3(0.25, 0.4, 0.25), select(u.debug.equal(4), typeId(type), select(u.debug.equal(2), levelRamp, palette)));
  },

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
  },
};
