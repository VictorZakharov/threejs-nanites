// NaniteForest methods: the far-field impostor quads (camera view and shadow casters), from the baked atlas
// (src/impostors.js).
import * as THREE from 'three/webgpu';
import {
  Fn, If, storage, uniformArray, instanceIndex, vertexIndex, uint, float, vec2, vec3, vec4, select, max, min,
  varying, normalLocal, texture, mix, hash, length, clamp, smoothstep, dFdx, dFdy, log2, cross,
  cameraViewMatrix, normalize, asin, cos, sin, screenCoordinate, bool,
} from 'three/tsl';
import { curve } from '../planet.ts';
import { IMPOSTOR_CUT, ELEVATIONS, TILE_W, TILE_H, atlasLayout } from '../impostors.ts';
import { MIN_PX, FADE_HI, PHASE2_LAYER, IMP_ARGS } from './constants.ts';
import { treeTint, dither, ditherAlt, typeId, switchPx } from './shading.ts';
import type { StorageBufferNode, UniformArrayNode, TextureNode } from 'three/webgpu';
import type { NaniteForest } from './forest.ts';
import type { View } from './types.ts';
import type { ImpostorAtlas } from '../impostors.ts';
import type { TreeVariant } from '../trees.ts';
import type { Bool, Float, Uint, Vec2, Vec3 } from '../types.ts';
import { setEmissive } from '../three-gaps.ts';
import { autumnOf, autumnColour } from '../autumn.ts';

/** A billboard's shader pieces (see _impostorQuad). */
interface ImpostorQuad {
  vUv: Vec2;
  vBlend: Vec2;
  vType: Float;
  vTint: Float;
  vAutumn: Float;
  vFade: Float;
  vRight: Vec3;
  vUp: Vec3;
  vDir: Vec3;
  vShadowPos: Vec3;
  position: Vec3;
  uv: Vec2[];
  t: TextureNode[];
  tile: Uint;
  a: Float[];
  elev: Float[];
  alpha: Float;
  coverage: Float;
}
// impostor alpha: 'dither' (by coverage, averaged by TAA; the default with TAA on) or 'cut' (`?impalpha=`)
const IMP_DITHER = (new URLSearchParams(location.search).get('impalpha') ?? (new URLSearchParams(location.search).get('taa') === '0' ? 'cut' : 'dither')) === 'dither';
const IMP_COV = Number(new URLSearchParams(location.search).get('impcov') ?? 0.9); // (coverage scale: matches the cut-out's mean colour)
// per baked elevation (ELEVATIONS): how much the quad is enlarged (see grow below); ?grow=a,b,c,d to calibrate
const GROW = (new URLSearchParams(location.search).get('grow') ?? '1,1.15,1.45,1.5').split(',').map(Number);
const GROW_MAX = Math.max(...GROW);
// the share of sub-MIN_PX trees kept: drawn MIN_PX / w times wider and taller, a tree keeps its coverage when (w /
// MIN_PX)^2 of them are drawn (?impkeep=width: w / MIN_PX, MIN_PX / w times the coverage)
const KEEP_AREA = new URLSearchParams(location.search).get('impkeep') !== 'width';
const keepShare = (wPx: Float): Float => (KEEP_AREA ? wPx.div(MIN_PX).pow(2) : wPx.div(MIN_PX));
const deg = Math.PI / 180;
// the elevation tiles are evenly spaced from 0 (each blends with the next round the midpoint between them, +-7.5
// degrees: the bands don't overlap, so at most two tiles have weight)
const ELEV_STEP = ELEVATIONS[1] - ELEVATIONS[0];
if (ELEVATIONS.some((e, k) => e !== k * ELEV_STEP)) throw new Error('ELEVATIONS must be evenly spaced from 0');
// an impostor's quad, indexed: its vertex shader runs 4 times, not 6 (as the leaf cards, LEAF_INDEX in draw.ts); from
// high up a phone draws ~500k of them, and its time followed their count, not the pixels
const IMP_INDEX = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
// extra colour gains on top of each variant's impGain (side / top-down views), for experiments: ?impgain=r,g,b
const gainParam = (name: string): number[] => (new URLSearchParams(location.search).get(name) ?? '1,1,1').split(',').map(Number);
const IMP_GAIN = gainParam('impgain');
const IMP_GAIN_TOP = gainParam('impgaintop');
const v3 = (c: number[]) => new THREE.Vector3(c[0], c[1], c[2]);

export const billboardMethods = {
  // ------------------------------------------------------------------ impostors (far field)
  /**
   * False if tree i's impostor is sure to be thinned out (the quad's own test below, MIN_PX, with its widest
   * enlargement: it keeps all the quad would): the instance pass then doesn't list it. Listed, the quads collapsed
   * themselves: from 9 km up a phone drew 898k impostors for a 288x521 screen, and phase 2 tested them all.
   */
  _impostorKept(this: NaniteForest, i: Uint): Bool {
    const u = this.u;
    const a = this._a(i), s = a.w;
    const fr = this.impFrame.element(uint(this._b(i).z));
    const pivot = a.xyz.add(vec3(0, fr.y.mul(s).mul(0.5), 0));
    const wPx = fr.x.mul(s).mul(GROW_MAX).mul(u.projScale).div(max(length(u.camPos.sub(pivot)), 0.1));
    return wPx.greaterThanEqual(MIN_PX).or(hash(i.add(7)).lessThan(keepShare(wPx)));
  },

  /**
   * The billboard of tree `instanceIndex` (one quad, 4 vertices), facing `dirOf(pivot)` (towards the viewer: the
   * camera, or the sun for the shadow casters), showing the atlas tiles baked from the nearest elevations (0, 30,
   * 60, 90 degrees; see ELEVATIONS): upright when seen from the side (base on the ground), lying flat when seen from
   * above (a cylindrical billboard would be seen edge-on from above, leaving a bald patch under the camera).
   * Returns the position node, the varyings and for the two tiles it blends (i = 0, 1): q.t[i] (albedo sample),
   * q.uv[i], q.a[i] (alpha), q.elev[i] (degrees). Two, not all four: a pixel sampled 8 atlas texels, from high up
   * ~500k impostors on a phone.
   * `screen`: the camera's quads (sub-pixel trees thinned out, cross-fade share with the geometry, shading inputs).
   */
  _impostorQuad(this: NaniteForest, atlas: ImpostorAtlas, list: StorageBufferNode<'uint'>, dirOf: (pivot: Vec3) => Vec3, screen: boolean): ImpostorQuad {
    const u = this.u;
    const n = atlas.frames.length;
    const frameW = uniformArray<'float'>(atlas.frames.map((f) => f.w), 'float');
    atlas.frames.forEach((f, k) => this.impFrameValues[k]?.set(f.w, f.h, 0, 0)); // (for _impostorKept)
    const frameH = uniformArray<'float'>(atlas.frames.map((f) => f.h), 'float');
    const growArr = uniformArray<'float'>(GROW, 'float');
    const v = {
      vUv: varying(vec2(0), 'vImpUv'),
      vBlend: varying(vec2(0), 'vImpBlend'), // the lower of the two tiles it blends (ELEVATIONS index), the upper's weight
      vType: varying(float(0), 'vImpType'),
      vTint: varying(float(1), 'vImpTint'),
      vAutumn: varying(float(0), 'vImpAutumn'), // (src/autumn.ts)
      vFade: varying(float(0), 'vImpFade'), // share drawn as geometry (cross-fade band)
      vRight: varying(vec3(1, 0, 0), 'vImpRight'), // billboard basis (right incl. mirroring), for the normals
      vUp: varying(vec3(0, 1, 0), 'vImpUp'),
      vDir: varying(vec3(0, 0, 1), 'vImpDir'),
      // where the quad's pixels look up the shadow map: moved towards the sun past the tree's own sun-facing caster
      // quad (its self-shadow is the average treeshade instead, see lighting.js and main.js); the neighbours' shadows remain
      vShadowPos: varying(vec3(0), 'vImpShadowPos'),
    };
    const q = v;
    const position = Fn(() => {
      const inst = list.element(instanceIndex).toVar(); // (one instance per listed impostor, see View.impListAttr)
      const on = bool(true).toVar();
      const a = this._a(inst), b = this._b(inst);
      const type = uint(b.z);
      const ti = this.typeInfo.element(type);
      const s = a.w;
      // corners of the quad (0,0) (1,0) (1,1) (0,1), two triangles by IMP_INDEX
      const vi = vertexIndex;
      const cx = select(vi.equal(1).or(vi.equal(2)), float(1), float(0));
      const cy = select(vi.equal(2).or(vi.equal(3)), float(1), float(0));
      const h0 = frameH.element(type).mul(s);
      const pivot = a.xyz.add(vec3(0, h0.mul(0.5), 0));
      const dir = dirOf(pivot);
      // tile weights by elevation: each switches to the next halfway between them, over +-7.5 degrees (with only
      // side and top tiles, the whole screen looked straight down at from high up was one flat top view: trees
      // towards the edges don't lean outwards like real ones)
      const elev = asin(clamp(dir.y, -1, 1)).div(deg);
      const mid = ELEV_STEP / 2;
      const j = clamp(elev.sub(mid).div(ELEV_STEP).round(), 0, ELEVATIONS.length - 2); // (the band it's nearest)
      const blend = smoothstep(mid - 7.5, mid + 7.5, elev.sub(j.mul(ELEV_STEP)));
      // seen from above, the coarse cluster LODs it replaces read wider than the crown in the atlas (fewer, grown
      // leaf cards): enlarge the higher views to match, so the forest doesn't thin out at the switch
      // (the shadow casters too: the geometry's shadow comes from the same fat coarse LODs)
      const ju = uint(j);
      const grow = mix(growArr.element(ju), growArr.element(ju.add(1)), blend).toVar();
      if (screen) {
        // sub-pixel trees shimmer (they hit or miss pixel centres as the camera moves): never draw a quad narrower
        // than MIN_PX; keep the forest's coverage by dropping a matching share of the trees instead (per tree, so
        // there's no flicker, only a rare tree fading out as you climb)
        const wPx = frameW.element(type).mul(s).mul(grow).mul(u.projScale).div(max(length(u.camPos.sub(pivot)), 0.1));
        If(wPx.lessThan(MIN_PX), () => {
          on.assign(on.and(hash(inst.add(7)).lessThan(keepShare(wPx))));
          grow.mulAssign(float(MIN_PX).div(max(wPx, 1e-3)));
        });
        // same projected height as the instance pass (geometry share of the cross-fade)
        const dCam = length(a.xyz.add(vec3(0, ti.w.mul(0.5).mul(s), 0)).sub(this.main.lodPos));
        const px = ti.w.mul(s).mul(u.projScale).div(max(dCam, 0.1));
        const sw = switchPx(u, inst);
        q.vFade.assign(smoothstep(sw, sw.mul(FADE_HI), px));
      }
      const w = frameW.element(type).mul(s).mul(grow), h = h0.mul(grow);
      const right = vec3(dir.z, 0, dir.x.negate()).add(vec3(1e-4, 0, 0)).normalize();
      const up = cross(dir, right);
      const flip = hash(inst).greaterThan(0.5); // mirror half of them for variety
      const ux = select(flip, cx.oneMinus(), cx);
      q.vUv.assign(vec2(ux, cy.oneMinus())); // (within the tile; render targets are stored flipped)
      q.vBlend.assign(vec2(j, blend));
      q.vType.assign(float(type));
      const p = pivot.add(right.mul(cx.sub(0.5).mul(w))).add(up.mul(cy.sub(0.5).mul(h)));
      if (screen) {
        q.vTint.assign(treeTint(inst));
        q.vAutumn.assign(select(this.textures.leafLayerOf(type).equal(3), float(0), autumnOf(b.w))); // (pines stay green)
        q.vRight.assign(select(flip, right.negate(), right));
        q.vUp.assign(up);
        q.vDir.assign(dir);
        q.vShadowPos.assign(curve(p.add(u.sunDir.mul(w.add(h).mul(0.5)))));
        normalLocal.assign(dir);
      }
      return select(on, curve(p), vec3(0));
    })();
    // alpha: the cross-fade between elevations is the union of the silhouettes (mixing their alphas would keep only
    // the overlap and thin the forest out); coverage-preserving by the sampled mip (impostorCoverage)
    // tile k * n + type of the atlas (atlasLayout: columns, then rows), for the two tiles k = j, j + 1 it blends
    const { cols, rows } = atlasLayout(n);
    const j = q.vBlend.x.round(), ks = [j, j.add(1)], wts = [q.vBlend.y.oneMinus(), q.vBlend.y];
    const elev = ks.map((k) => k.mul(ELEV_STEP));
    const uv = ks.map((k) => {
      const t = q.vType.round().add(k.mul(n)), row = t.div(cols).floor(), col = t.sub(row.mul(cols));
      return q.vUv.add(vec2(col, row)).div(vec2(cols, rows));
    });
    const t = uv.map((c) => texture(atlas.texture, c));
    const { scales, levels } = atlas.coverage;
    const scaleArr = uniformArray<'float'>(Array.from(scales), 'float');
    const texel = q.vUv.mul(vec2(TILE_W, TILE_H));
    const lod = clamp(log2(max(length(dFdx(texel)), length(dFdy(texel)))), 0, levels - 1.001);
    const scaleOf = (tile: Uint): Float => {
      const i0 = tile.mul(levels).add(uint(lod.floor()));
      return mix(scaleArr.element(i0), scaleArr.element(i0.add(1)), lod.fract());
    };
    const tile = uint(q.vType.round());
    const a = t.map((tk, i) => tk.a.mul(scaleOf(tile.add(uint(ks[i]).mul(n)))).mul(clamp(wts[i].mul(2), 0, 1)));
    const alpha = min(max(a[0], a[1]), 1);
    // the plain filtered alpha: the share of the pixel the tree covers (see IMP_DITHER)
    const coverage = min(max(t[0].a.mul(clamp(wts[0].mul(2), 0, 1)), t[1].a.mul(clamp(wts[1].mul(2), 0, 1))), 1);
    return { ...v, position, uv, t, tile, a, elev, alpha, coverage };
  },

  /** atlas: { texture, frames: [{w, h}], renderTarget, coverage } from bakeImpostors + impostorCoverage: per tree type a side tile and a top-down tile. */
  /** `gains`: per tree type, { side: [r, g, b], top: [r, g, b] } colour gains (VARIANTS[i].impGain). */
  buildImpostorMesh(this: NaniteForest, atlas: ImpostorAtlas, gains: TreeVariant['impGain'][]): THREE.Mesh {
    const u = this.u;
    const list = storage(this.main.impListAttr, 'uint', this.instanceCount).toReadOnly();
    const q = this._impostorQuad(atlas, list, (pivot) => u.camPos.sub(pivot).normalize(), true);
    const { vRight, vUp, vDir, vTint, vFade, tile } = q;
    // lit like the real leaves (Lambert, same lights, shadow fade and fog), from baked albedo + normals
    const mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: IMP_DITHER ? 0.5 : IMPOSTOR_CUT });
    mat.alphaToCoverage = !IMP_DITHER && this.textures.alphaToCoverage;
    const wSum = max(q.a.reduce((m, a) => m.add(a)), 1e-4);
    // (MSAA-resolved edges are premultiplied by coverage: divide it out)
    const albedo = q.t.reduce<Vec3>((acc, t, k) => acc.add(t.rgb.div(max(t.a, 1e-3)).mul(q.a[k])), vec3(0)).div(wSum);
    // tree-local normals to world: tile k looks from +z tilted up by e (screen right +x, up (0, cos e, -sin e))
    const nWorld = q.uv.reduce<Vec3>((acc, uv, i) => {
      const n = texture(atlas.normals, uv).xyz;
      const c = cos(q.elev[i].mul(deg)), sn = sin(q.elev[i].mul(deg));
      const up = n.y.mul(c).sub(n.z.mul(sn)), toward = n.y.mul(sn).add(n.z.mul(c));
      return acc.add(vRight.mul(n.x).add(vUp.mul(up)).add(vDir.mul(toward)).mul(q.a[i]));
    }, vec3(0));
    mat.normalNode = normalize(cameraViewMatrix.mul(vec4(nWorld.add(vDir.mul(1e-3)), 0)).xyz);
    mat.receivedShadowPositionNode = q.vShadowPos;
    // (the gains: measured against the real trees; partly the sub-pixel leaves of the real trees, which blend with
    // what's behind them and read paler than the solid baked crowns)
    const gainSide = uniformArray<'vec3'>(gains.map((g) => v3(g.side).multiply(v3(IMP_GAIN))), 'vec3');
    const gainTop = uniformArray<'vec3'>(gains.map((g) => v3(g.top).multiply(v3(IMP_GAIN_TOP))), 'vec3');
    this.impGains = { side: gainSide, top: gainTop }; // (live: harness --typematch=calibrate adjusts them)
    // (the tiles between: side and top gains mixed by elevation)
    const gS = gainSide.element(tile), gT = gainTop.element(tile);
    const gain = q.elev.reduce<Vec3>((acc, e, i) => acc.add(mix(gS, gT, e.div(90)).mul(q.a[i])), vec3(0)).div(wSum);
    // (autumn on the leaf texels only: the atlas has bark too, and leaves are the green ones)
    const green = albedo.mul(vec3(vTint.mul(0.92), vTint, vTint.mul(0.8))).mul(gain);
    const col = autumnColour(green, q.vAutumn, smoothstep(0, 0.03, green.g.sub(max(green.r, green.b))));
    // the other half of the geometry's dithered cross-fade
    // (IMP_DITHER: each pixel drawn with the probability of its coverage, a dither that moves every frame, which
    // TAA averages; the sharpened cut-out made each few-pixel tree a hard blob that shimmered as it moved)
    const cut = IMP_DITHER ? select(q.coverage.mul(IMP_COV).greaterThan(ditherAlt(screenCoordinate.xy)), float(1), float(0)) : q.alpha;
    const alpha = select(dither().lessThan(vFade), float(0), cut);
    mat.colorNode = vec4(select(u.debug.greaterThan(0), vec3(0), col), alpha);
    setEmissive(mat, select(u.debug.equal(4), typeId(tile), select(u.debug.greaterThan(0), vec3(0.9, 0.2, 0.8), col.mul(0.12))));
    mat.positionNode = q.position;
    const mesh = new THREE.Mesh(this._impostorGeometry(this.main), mat);
    mesh.frustumCulled = false;
    mesh.name = 'nanite-impostors';
    // drawn in phase 2, after occlusion() has dropped the hidden ones (with occlusion off, all flagged ones)
    mesh.layers.set(PHASE2_LAYER);
    return mesh;
  },

  /**
   * The impostors' shadow: trees the shadow view leaves as impostors cast their billboard, turned to the sun, into
   * the shadow map. Without it, the ground and trees around them fell back to an average shadow, which changed at
   * the geometry switch and with the zoom.
   */
  buildImpostorShadowMesh(this: NaniteForest, atlas: ImpostorAtlas): THREE.Mesh {
    const list = storage(this.shadow.impListAttr, 'uint', this.instanceCount).toReadOnly();
    const q = this._impostorQuad(atlas, list, () => this.u.sunDir, false);
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: IMPOSTOR_CUT });
    mat.colorNode = vec4(1, 1, 1, q.alpha);
    mat.positionNode = q.position;
    const mesh = new THREE.Mesh(this._impostorGeometry(this.shadow), mat);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.layers.set(1); // only the shadow camera renders it
    mesh.name = 'nanite-impostors-shadow';
    return mesh;
  },

  /** One instance per impostor the view listed this frame (the draw args in its counters, IMP_ARGS). */
  _impostorGeometry(this: NaniteForest, view: View): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
    geo.setIndex(IMP_INDEX);
    geo.setIndirect(view.ctr.attr, IMP_ARGS * 4); // (byte offset)
    return geo;
  },
};
