// NaniteForest methods: the far-field impostor quads (camera view and shadow casters), from the baked atlas
// (src/impostors.js).
import * as THREE from 'three/webgpu';
import {
  Fn, If, storage, uniformArray, instanceIndex, vertexIndex, uint, float, vec2, vec3, vec4, select, max, min,
  varying, normalLocal, texture, mix, hash, length, dot, clamp, smoothstep, dFdx, dFdy, log2, cross,
  cameraViewMatrix, normalize,
} from 'three/tsl';
import { curve } from '../planet.js';
import { IMPOSTOR_CUT, ELEVATIONS } from '../impostors.js';
import { MIN_PX, FADE_HI, PHASE2_LAYER } from './constants.js';
import { treeTint, dither, typeId } from './shading.js';
const TOP_GROW = Number(new URLSearchParams(location.search).get('topgrow') ?? 1.25);
const MID_GROW = Number(new URLSearchParams(location.search).get('midgrow') ?? 1.2); // (the 45 degree tile's)
// extra colour gains on top of each variant's impGain (side / top-down views), for experiments: ?impgain=r,g,b
const gainParam = (name) => (new URLSearchParams(location.search).get(name) ?? '1,1,1').split(',').map(Number);
const IMP_GAIN = gainParam('impgain');
const IMP_GAIN_TOP = gainParam('impgaintop');

export const billboardMethods = {
  // ------------------------------------------------------------------ impostors (far field)
  /**
   * The billboard of tree `instanceIndex` (one quad, 6 vertices), facing `dirOf(pivot)` (towards the viewer: the
   * camera, or the sun for the shadow casters), showing the atlas tile baked from the nearest elevation (side, 45
   * degrees, top; see ELEVATIONS): upright when seen from the side (base on the ground), lying flat when seen from
   * above (a cylindrical billboard would be seen edge-on from above, leaving a bald patch under the camera).
   * Returns the position node, the varyings and per elevation k: q.t[k] (albedo sample), q.uv[k], q.a[k] (alpha).
   * `screen`: the camera's quads (sub-pixel trees thinned out, cross-fade share with the geometry, shading inputs).
   */
  _impostorQuad(atlas, flags, dirOf, screen) {
    const u = this.u;
    const n = atlas.frames.length;
    const frameW = uniformArray(atlas.frames.map((f) => f.w), 'float');
    const frameH = uniformArray(atlas.frames.map((f) => f.h), 'float');
    const q = {
      vUv: varying(vec2(0), 'vImpUv'),
      vW: varying(vec3(1, 0, 0), 'vImpW'), // weights of the side, 45 degree and top tiles
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
    q.position = Fn(() => {
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
      const h0 = frameH.element(type).mul(s);
      const pivot = a.xyz.add(vec3(0, h0.mul(0.5), 0));
      const dir = dirOf(pivot);
      // tile weights by elevation (dir.y = sin): switch halfway between the baked ones (~22 and ~67 degrees)
      const sideMid = smoothstep(0.25, 0.45, dir.y), midTop = smoothstep(0.87, 0.96, dir.y);
      const weights = vec3(sideMid.oneMinus(), sideMid.sub(midTop), midTop);
      // seen from above, the coarse cluster LODs it replaces read wider than the crown in the atlas (fewer, grown
      // leaf cards): enlarge the 45 degree and top views to match, so the forest doesn't thin out at the switch
      const grow = dot(weights, vec3(1, MID_GROW, TOP_GROW)).toVar();
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
        q.vFade.assign(smoothstep(u.impostorPx, u.impostorPx.mul(FADE_HI), px));
      }
      const w = frameW.element(type).mul(s).mul(grow), h = h0.mul(grow);
      const right = vec3(dir.z, 0, dir.x.negate()).add(vec3(1e-4, 0, 0)).normalize();
      const up = cross(dir, right);
      const flip = hash(inst).greaterThan(0.5); // mirror half of them for variety
      const ux = select(flip, cx.oneMinus(), cx);
      q.vUv.assign(vec2(float(type).add(ux).div(ELEVATIONS.length * n), cy.oneMinus())); // (render targets are stored flipped)
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
    q.uv = ELEVATIONS.map((e, k) => q.vUv.add(vec2(k / ELEVATIONS.length, 0))); // (one atlas block per elevation)
    q.t = q.uv.map((uv) => texture(atlas.texture, uv));
    const { scales, levels } = atlas.coverage;
    const scaleArr = uniformArray(Array.from(scales), 'float');
    const texel = q.vUv.mul(vec2(atlas.renderTarget.width, atlas.renderTarget.height));
    const lod = clamp(log2(max(length(dFdx(texel)), length(dFdy(texel)))), 0, levels - 1.001);
    const scaleOf = (tile) => {
      const i0 = tile.mul(levels).add(uint(lod.floor()));
      return mix(scaleArr.element(i0), scaleArr.element(i0.add(1)), lod.fract());
    };
    q.tile = uint(q.vType.round());
    const w = [q.vW.x, q.vW.y, q.vW.z];
    q.a = q.t.map((t, k) => t.a.mul(scaleOf(q.tile.add(k * n))).mul(clamp(w[k].mul(2), 0, 1)));
    q.alpha = min(max(max(q.a[0], q.a[1]), q.a[2]), 1);
    return q;
  },

  /** atlas: { texture, frames: [{w, h}], renderTarget, coverage } from bakeImpostors + impostorCoverage: per tree type a side tile and a top-down tile. */
  /** `gains`: per tree type, { side: [r, g, b], top: [r, g, b] } colour gains (VARIANTS[i].impGain). */
  buildImpostorMesh(atlas, gains) {
    const u = this.u;
    const flags = storage(this.main.impFlagAttr, 'uint', this.instanceCount).toReadOnly();
    const q = this._impostorQuad(atlas, flags, (pivot) => u.camPos.sub(pivot).normalize(), true);
    const { vRight, vUp, vDir, vTint, vFade, tile } = q;
    // lit like the real leaves (Lambert, same lights, shadow fade and fog), from baked albedo + normals
    const mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: IMPOSTOR_CUT });
    mat.alphaToCoverage = this.textures.alphaToCoverage;
    const wSum = max(q.a[0].add(q.a[1]).add(q.a[2]), 1e-4);
    // (MSAA-resolved edges are premultiplied by coverage: divide it out)
    const albedo = q.t.reduce((acc, t, k) => acc.add(t.rgb.div(max(t.a, 1e-3)).mul(q.a[k])), vec3(0)).div(wSum);
    // tree-local normals to world: tile k looks from +z tilted up by e (screen right +x, up (0, cos e, -sin e))
    const nWorld = ELEVATIONS.reduce((acc, deg, k) => {
      const n = texture(atlas.normals, q.uv[k]).xyz;
      const c = Math.cos((deg * Math.PI) / 180), sn = Math.sin((deg * Math.PI) / 180);
      const up = n.y.mul(c).sub(n.z.mul(sn)), toward = n.y.mul(sn).add(n.z.mul(c));
      return acc.add(vRight.mul(n.x).add(vUp.mul(up)).add(vDir.mul(toward)).mul(q.a[k]));
    }, vec3(0));
    mat.normalNode = normalize(cameraViewMatrix.mul(vec4(nWorld.add(vDir.mul(1e-3)), 0)).xyz);
    mat.receivedShadowPositionNode = q.vShadowPos;
    // (the gains: measured against the real trees; partly the sub-pixel leaves of the real trees, which blend with
    // what's behind them and read paler than the solid baked crowns)
    const gainSide = uniformArray(gains.map((g) => new THREE.Vector3(...g.side).multiply(new THREE.Vector3(...IMP_GAIN))), 'vec3');
    const gainTop = uniformArray(gains.map((g) => new THREE.Vector3(...g.top).multiply(new THREE.Vector3(...IMP_GAIN_TOP))), 'vec3');
    this.impGains = { side: gainSide, top: gainTop }; // (live: harness --typematch=calibrate adjusts them)
    // (the 45 degree tile: halfway between the side and top gains)
    const gS = gainSide.element(tile), gT = gainTop.element(tile);
    const gain = gS.mul(q.a[0]).add(gS.add(gT).mul(0.5).mul(q.a[1])).add(gT.mul(q.a[2])).div(wSum);
    const col = albedo.mul(vec3(vTint.mul(0.92), vTint, vTint.mul(0.8))).mul(gain);
    // the other half of the geometry's dithered cross-fade
    const alpha = select(dither().lessThan(vFade), float(0), q.alpha);
    mat.colorNode = vec4(select(u.debug.greaterThan(0), vec3(0), col), alpha);
    mat.emissiveNode = select(u.debug.equal(4), typeId(tile), select(u.debug.greaterThan(0), vec3(0.9, 0.2, 0.8), col.mul(0.12)));
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
  buildImpostorShadowMesh(atlas) {
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
  _impostorGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    geo.setIndirect(new THREE.IndirectStorageBufferAttribute(new Uint32Array([6, this.instanceCount, 0, 0]), 4));
    return geo;
  },
};
