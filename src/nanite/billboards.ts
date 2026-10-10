// NaniteForest methods: the far-field impostor quads (camera view and shadow casters), from the baked atlas
// (src/impostors.js).
import * as THREE from 'three/webgpu';
import {
  Fn, If, storage, uniformArray, instanceIndex, vertexIndex, uint, float, vec2, vec3, vec4, select, max, min,
  varying, normalLocal, texture, mix, hash, length, dot, clamp, smoothstep, dFdx, dFdy, log2, cross,
  cameraViewMatrix, normalize, asin, screenCoordinate,
} from 'three/tsl';
import { curve } from '../planet.ts';
import { IMPOSTOR_CUT, ELEVATIONS, TILE_W, TILE_H, atlasLayout } from '../impostors.ts';
import { MIN_PX, FADE_HI, PHASE2_LAYER } from './constants.ts';
import { treeTint, dither, ditherAlt, typeId, switchPx } from './shading.ts';
import type { StorageBufferNode, UniformArrayNode, TextureNode } from 'three/webgpu';
import type { NaniteForest } from './forest.ts';
import type { ImpostorAtlas } from '../impostors.ts';
import type { TreeVariant } from '../trees.ts';
import type { Float, Uint, Vec2, Vec3 } from '../types.ts';
import { setEmissive } from '../three-gaps.ts';

/** A billboard's shader pieces (see _impostorQuad). */
interface ImpostorQuad {
  vUv: Vec2;
  vW: ReturnType<typeof varying<'vec4'>>;
  vType: Float;
  vTint: Float;
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
  alpha: Float;
  coverage: Float;
}
// impostor alpha: 'dither' (by coverage, averaged by TAA; the default with TAA on) or 'cut' (`?impalpha=`)
const IMP_DITHER = (new URLSearchParams(location.search).get('impalpha') ?? (new URLSearchParams(location.search).get('taa') === '0' ? 'cut' : 'dither')) === 'dither';
const IMP_COV = Number(new URLSearchParams(location.search).get('impcov') ?? 0.9); // (coverage scale: matches the cut-out's mean colour)
// per baked elevation (ELEVATIONS): how much the quad is enlarged (see grow below); ?grow=a,b,c,d to calibrate
const GROW = (new URLSearchParams(location.search).get('grow') ?? '1,1.15,1.45,1.5').split(',').map(Number);
const deg = Math.PI / 180;
// extra colour gains on top of each variant's impGain (side / top-down views), for experiments: ?impgain=r,g,b
const gainParam = (name: string): number[] => (new URLSearchParams(location.search).get(name) ?? '1,1,1').split(',').map(Number);
const IMP_GAIN = gainParam('impgain');
const IMP_GAIN_TOP = gainParam('impgaintop');
const v3 = (c: number[]) => new THREE.Vector3(c[0], c[1], c[2]);

export const billboardMethods = {
  // ------------------------------------------------------------------ impostors (far field)
  /**
   * The billboard of tree `instanceIndex` (one quad, 6 vertices), facing `dirOf(pivot)` (towards the viewer: the
   * camera, or the sun for the shadow casters), showing the atlas tiles baked from the nearest elevations (0, 30,
   * 60, 90 degrees; see ELEVATIONS): upright when seen from the side (base on the ground), lying flat when seen from
   * above (a cylindrical billboard would be seen edge-on from above, leaving a bald patch under the camera).
   * Returns the position node, the varyings and per elevation k: q.t[k] (albedo sample), q.uv[k], q.a[k] (alpha).
   * `screen`: the camera's quads (sub-pixel trees thinned out, cross-fade share with the geometry, shading inputs).
   */
  _impostorQuad(this: NaniteForest, atlas: ImpostorAtlas, flags: StorageBufferNode<'uint'>, dirOf: (pivot: Vec3) => Vec3, screen: boolean): ImpostorQuad {
    const u = this.u;
    const n = atlas.frames.length;
    const frameW = uniformArray<'float'>(atlas.frames.map((f) => f.w), 'float');
    const frameH = uniformArray<'float'>(atlas.frames.map((f) => f.h), 'float');
    const v = {
      vUv: varying(vec2(0), 'vImpUv'),
      vW: varying(vec4(1, 0, 0, 0), 'vImpW'), // weights of the tiles (ELEVATIONS)
      vType: varying(float(0), 'vImpType'),
      vTint: varying(float(1), 'vImpTint'),
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
      const inst = instanceIndex;
      const on = flags.element(inst).equal(1).toVar();
      const a = this._a(inst), b = this._b(inst);
      const type = uint(b.z);
      const ti = this.typeInfo.element(type);
      const s = a.w;
      // corners of a quad, two triangles: (0,0) (1,0) (1,1) / (0,0) (1,1) (0,1)
      const vi = vertexIndex;
      const cx = select(vi.equal(1).or(vi.equal(2)).or(vi.equal(4)), float(1), float(0));
      const cy = select(vi.equal(2).or(vi.equal(4)).or(vi.equal(5)), float(1), float(0));
      const h0 = frameH.element(type).mul(s);
      const pivot = a.xyz.add(vec3(0, h0.mul(0.5), 0));
      const dir = dirOf(pivot);
      // tile weights by elevation: each switches to the next halfway between them, over +-7.5 degrees (with only
      // side and top tiles, the whole screen looked straight down at from high up was one flat top view: trees
      // towards the edges don't lean outwards like real ones)
      const elev = asin(clamp(dir.y, -1, 1)).div(deg);
      const steps: Float[] = ELEVATIONS.slice(1).map((e, k) => smoothstep((ELEVATIONS[k] + e) / 2 - 7.5, (ELEVATIONS[k] + e) / 2 + 7.5, elev));
      const wk = ELEVATIONS.map((e, k) => (k === 0 ? steps[0].oneMinus() : k === steps.length ? steps[k - 1] : steps[k - 1].sub(steps[k])));
      const weights = vec4(wk[0], wk[1], wk[2], wk[3]);
      // seen from above, the coarse cluster LODs it replaces read wider than the crown in the atlas (fewer, grown
      // leaf cards): enlarge the higher views to match, so the forest doesn't thin out at the switch
      // (the shadow casters too: the geometry's shadow comes from the same fat coarse LODs)
      const grow = dot(weights, vec4(GROW[0], GROW[1], GROW[2], GROW[3])).toVar();
      if (screen) {
        // sub-pixel trees shimmer (they hit or miss pixel centres as the camera moves): never draw a quad narrower
        // than MIN_PX; keep the forest's coverage by dropping a matching share of the trees instead (per tree, so
        // there's no flicker, only a rare tree fading out as you climb)
        const wPx = frameW.element(type).mul(s).mul(grow).mul(u.projScale).div(max(length(u.camPos.sub(pivot)), 0.1));
        If(wPx.lessThan(MIN_PX), () => {
          on.assign(on.and(hash(inst.add(7)).lessThan(wPx.div(MIN_PX))));
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
      q.vW.assign(weights);
      q.vType.assign(float(type));
      const p = pivot.add(right.mul(cx.sub(0.5).mul(w))).add(up.mul(cy.sub(0.5).mul(h)));
      if (screen) {
        q.vTint.assign(treeTint(inst));
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
    // tile k * n + type of the atlas (atlasLayout: columns, then rows)
    const { cols, rows } = atlasLayout(n);
    const uv = ELEVATIONS.map((e, k) => {
      const t = q.vType.round().add(k * n), row = t.div(cols).floor(), col = t.sub(row.mul(cols));
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
    const w = [q.vW.x, q.vW.y, q.vW.z, q.vW.w];
    const a = t.map((tk, k) => tk.a.mul(scaleOf(tile.add(k * n))).mul(clamp(w[k].mul(2), 0, 1)));
    const alpha = min(a.reduce((m, ak) => max(m, ak)), 1);
    // the plain filtered alpha: the share of the pixel the tree covers (see IMP_DITHER)
    const coverage = min(t.map((tk, k) => tk.a.mul(clamp(w[k].mul(2), 0, 1))).reduce((m, ak) => max(m, ak)), 1);
    return { ...v, position, uv, t, tile, a, alpha, coverage };
  },

  /** atlas: { texture, frames: [{w, h}], renderTarget, coverage } from bakeImpostors + impostorCoverage: per tree type a side tile and a top-down tile. */
  /** `gains`: per tree type, { side: [r, g, b], top: [r, g, b] } colour gains (VARIANTS[i].impGain). */
  buildImpostorMesh(this: NaniteForest, atlas: ImpostorAtlas, gains: TreeVariant['impGain'][]): THREE.Mesh {
    const u = this.u;
    const flags = storage(this.main.impFlagAttr, 'uint', this.instanceCount).toReadOnly();
    const q = this._impostorQuad(atlas, flags, (pivot) => u.camPos.sub(pivot).normalize(), true);
    const { vRight, vUp, vDir, vTint, vFade, tile } = q;
    // lit like the real leaves (Lambert, same lights, shadow fade and fog), from baked albedo + normals
    const mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: IMP_DITHER ? 0.5 : IMPOSTOR_CUT });
    mat.alphaToCoverage = !IMP_DITHER && this.textures.alphaToCoverage;
    const wSum = max(q.a.reduce((m, a) => m.add(a)), 1e-4);
    // (MSAA-resolved edges are premultiplied by coverage: divide it out)
    const albedo = q.t.reduce<Vec3>((acc, t, k) => acc.add(t.rgb.div(max(t.a, 1e-3)).mul(q.a[k])), vec3(0)).div(wSum);
    // tree-local normals to world: tile k looks from +z tilted up by e (screen right +x, up (0, cos e, -sin e))
    const nWorld = ELEVATIONS.reduce<Vec3>((acc, e, k) => {
      const n = texture(atlas.normals, q.uv[k]).xyz;
      const c = Math.cos(e * deg), sn = Math.sin(e * deg);
      const up = n.y.mul(c).sub(n.z.mul(sn)), toward = n.y.mul(sn).add(n.z.mul(c));
      return acc.add(vRight.mul(n.x).add(vUp.mul(up)).add(vDir.mul(toward)).mul(q.a[k]));
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
    const gain = ELEVATIONS.reduce<Vec3>((acc, e, k) => acc.add(mix(gS, gT, e / 90).mul(q.a[k])), vec3(0)).div(wSum);
    const col = albedo.mul(vec3(vTint.mul(0.92), vTint, vTint.mul(0.8))).mul(gain);
    // the other half of the geometry's dithered cross-fade
    // (IMP_DITHER: each pixel drawn with the probability of its coverage, a dither that moves every frame, which
    // TAA averages; the sharpened cut-out made each few-pixel tree a hard blob that shimmered as it moved)
    const cut = IMP_DITHER ? select(q.coverage.mul(IMP_COV).greaterThan(ditherAlt(screenCoordinate.xy)), float(1), float(0)) : q.alpha;
    const alpha = select(dither().lessThan(vFade), float(0), cut);
    mat.colorNode = vec4(select(u.debug.greaterThan(0), vec3(0), col), alpha);
    setEmissive(mat, select(u.debug.equal(4), typeId(tile), select(u.debug.greaterThan(0), vec3(0.9, 0.2, 0.8), col.mul(0.12))));
    mat.positionNode = q.position;
    const mesh = new THREE.Mesh(this._impostorGeometry(), mat);
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
    const flags = storage(this.shadow.impFlagAttr, 'uint', this.instanceCount).toReadOnly();
    const q = this._impostorQuad(atlas, flags, () => this.u.sunDir, false);
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: IMPOSTOR_CUT });
    mat.colorNode = vec4(1, 1, 1, q.alpha);
    mat.positionNode = q.position;
    const mesh = new THREE.Mesh(this._impostorGeometry(), mat);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.layers.set(1); // only the shadow camera renders it
    mesh.name = 'nanite-impostors-shadow';
    return mesh;
  },

  /** One instance per tree; trees not flagged as impostors this frame collapse to a point. */
  _impostorGeometry(this: NaniteForest): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    geo.setIndirect(new THREE.IndirectStorageBufferAttribute(new Uint32Array([6, this.instanceCount, 0, 0]), 4));
    return geo;
  },
};
