// The WebGL mode's forest (issue #39): what three's WebGL 2 backend can draw without compute, storage buffers,
// atomics or indirect draws. Near trees are src/webgl/near.ts (fixed DAG cuts, instanced, picked by distance on the
// CPU); the rest are the impostors from the same baked atlas, one instanced quad per tree in 1 km cells that the CPU
// culls by frustum and fog, sharing the pixels with the near trees over the last level's band. No occlusion, no
// software rasterizer, no splats. The statues are src/webgl/statues.ts, with the near trees' bark material.
import * as THREE from 'three/webgpu';
import {
  Fn, cameraPosition, cameraViewMatrix, clamp, cross, float, fract, mix, normalize, select, sin, smoothstep, texture,
  uniform, varying, vec2, vec3, vec4, vertexIndex, asin, cos, max, min, length, screenCoordinate, textureLoad, ivec2, int, dFdx, dFdy, log2, exp2,
  hash, uint,
} from 'three/tsl';
import { curve, dropAtCPU } from '../planet.ts';
import { heightAt } from '../terrain.ts';
import { ELEVATIONS, atlasLayout, IMPOSTOR_CUT, TILE_W, TILE_H, type ImpostorAtlas } from '../impostors.ts';
import { GROW, GROW_SHADOW, IMP_DITHER, IMP_COV, DROP, DROP_FADE } from '../nanite/billboards.ts';
import { ditherAlt, mipBias } from '../nanite/shading.ts';
import { autumnOf, autumnColour } from '../autumn.ts';
import { isBush, VARIANTS, type BuiltTree } from '../trees.ts';
import { setEmissive } from '../three-gaps.ts';
import { isTouchDevice } from '../touch.ts';
import { iA, iB, typeOf, pick, jitter, hashOf, BAND, fadeKeep } from './instanced.ts';
import { withDebug, setLevel } from './debug.ts';
import { createNearTrees, NEAR_R, type NearTextures } from './near.ts';
import type { TreeInstances } from '../placement.ts';
import type { Float, Vec3 } from '../types.ts';

const params = new URLSearchParams(location.search);
const TOUCH = isTouchDevice(params);
const BUSH_FAR = Number(params.get('glbushes') ?? (TOUCH ? 350 : 700)); // m: bushes' impostors out to here
const BUCKET = 1024; // m: the impostors' cells
const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + cz + 4096; // (a cell's map key)
const MIN_PX = 2; // (impostors never narrower: smaller ones enlarged, a matching share dropped)
const CASTERS = params.get('glimpshadow') !== '0'; // (the impostors' shadow casters: ?glimpshadow=0 for none)
const deg = Math.PI / 180;

/** `treeShadow`: the trees' received shadow (lighting.ts makeFadeShadow); `impShadow` the impostors'. */
export function createWebGLForest(trees: BuiltTree[], inst: TreeInstances, tex: NearTextures, atlas: ImpostorAtlas, shading: {
  treeShadow: () => THREE.Node; impShadow: () => THREE.Node;
  wind: { time: THREE.UniformNode<'float', number>; prevTime: THREE.UniformNode<'float', number>; wind: THREE.UniformNode<'float', number> };
  taa: boolean; // (under TAA: alpha by coverage against the moving dither, as billboards.ts IMP_DITHER)
  sunDir: THREE.Vector3; // (towards the sun: the impostors' shadow casters)
}) {
  const group = new THREE.Group();
  group.name = 'webgl-forest';
  const count = inst.a.length / 4 - inst.statues;
  const nearCentre = uniform(new THREE.Vector3(1e9, 0, 0)); // (where the near scan was made: the impostors leave those out)
  const projScale = uniform(1); // pixels per metre at 1 m
  const nearScale = uniform(1); // the level radii's scale (setDetail)
  let scale = 1;
  const nearTrees = createNearTrees(trees, inst, tex, group, shading);

  // ------------------------------------------------------------------ far trees: impostors
  const n = trees.length;
  const { cols, rows } = atlasLayout(n);
  const pick3 = (values: number[][]): Vec3 => vec3(pick(values.map((c) => c[0])), pick(values.map((c) => c[1])), pick(values.map((c) => c[2])));
  const vUv = varying(vec2(0), 'vGlUv'), vTile = varying(float(0), 'vGlTile'), vElev = varying(float(0), 'vGlElev');
  const vRight = varying(vec3(1, 0, 0), 'vGlRight'), vUp = varying(vec3(0, 1, 0), 'vGlUp'), vDir = varying(vec3(0, 0, 1), 'vGlDir');
  const vTint = varying(float(1), 'vGlTint'), vAutumn = varying(float(0), 'vGlAutumn'), vCode = varying(float(0.5), 'vGlImpFade');
  const vCov = varying(float(1), 'vGlCov'), vSeed = varying(float(0), 'vGlSeed'); // (the coverage scale's holes: billboards.ts)
  // (?impcovside= / ?impcovtop=: a factor per variant instead of VARIANTS' impCov, as main.ts)
  const covOf = (k: 0 | 1, name: string): number[] => params.get(name)?.split(',').map(Number) ?? VARIANTS.map((v) => v.impCov[k]);
  const [covSide, covTop] = [covOf(0, 'impcovside'), covOf(1, 'impcovtop')];
  const bushType = VARIANTS.map((v) => (isBush(v) ? 1 : 0));
  const sunDir = uniform(shading.sunDir);
  const vShadowPos = varying(vec3(0), 'vGlShadowPos');
  /**
   * The quad, facing the camera, or (`toSun`) the sun: the shadow caster, as billboards.ts's (GROW_SHADOW: the
   * geometry's shadows come from coarser cuts, fat leaf cards), no MIN_PX enlarging.
   */
  const quadPosition = (toSun: boolean): Vec3 => Fn(() => {
    const s = iA.w;
    const fw = pick(atlas.frames.map((f) => f.w)), fh = pick(atlas.frames.map((f) => f.h)); // (filled by the bake)
    const pivot = iA.xyz.add(vec3(0, fh.mul(s).mul(0.5), 0));
    const toCam = cameraPosition.sub(pivot);
    const dist = max(length(toCam), 0.1);
    const dir = toSun ? sunDir : toCam.div(dist);
    const elev = asin(clamp(dir.y, -1, 1)).div(deg);
    const j = clamp(elev.div(ELEVATIONS[1]).round(), 0, ELEVATIONS.length - 1).toVar(); // (the nearest tile)
    const G = toSun ? GROW_SHADOW : GROW;
    const grow = G.slice(0, -1).reduceRight<Float>((acc, g, i) => select(j.equal(i), float(g), acc), float(G[G.length - 1])).toVar();
    const h = hashOf(iA);
    const wPx = fw.mul(s).mul(grow).mul(projScale).div(dist);
    // (MIN_PX: a tree's rank in its cell, shuffled, against the share that keeps the coverage; the CPU draws only
    // the cell's first ones, up to the share at its nearest edge)
    // (the casters are thinned by the camera's tests too, as WebGPU's shadow view lists them: _impostorKept)
    const keep = select(wPx.lessThan(MIN_PX), fract(iB.z).mul(2).lessThan(wPx.div(MIN_PX).pow(2)), wPx.greaterThan(-1)).toVar();
    // the type's coverage scale by elevation (impCov: where its impostors cover more than its trees, holes), and far
    // below the switch that share of its trees drawn, solid, instead (billboards.ts impostorCov, impostorShare)
    const cov = mix(pick(covSide), pick(covTop), clamp(elev.div(90), 0, 1)).toVar();
    vSeed.assign(hashOf(iA.add(vec4(3.7, 0, 1.3, 0))).mul(4096).floor());
    if (DROP[0] > 0) {
      const share = mix(float(1), min(cov, 1), smoothstep(DROP[0], DROP[1], wPx)).toVar();
      const k = clamp(share.sub(hashOf(iA.add(vec4(9.1, 0, 5.3, 0))).mul(1 - DROP_FADE).add(DROP_FADE / 2)).div(DROP_FADE).add(0.5), 0, 1);
      if (!toSun) cov.assign(cov.div(share).mul(k));
      keep.assign(keep.and(k.greaterThan(0)));
    }
    vCov.assign(cov);
    if (!toSun) grow.mulAssign(max(float(MIN_PX).div(max(wPx, 1e-3)), 1));
    // not where the near scan drew it as geometry, nor a bush past BUSH_FAR
    // (over the last level's band it shares the pixels with the geometry: near.ts, instanced.ts fadeCode)
    const dNear = length(iA.xyz.sub(nearCentre)), R = jitter(s).mul(NEAR_R).mul(nearScale);
    vCode.assign(clamp(dNear.sub(R.mul(1 - BAND)).div(R.mul(2 * BAND).max(1e-3)), 0, 1).mul(0.2).add(0.3));
    const show = keep.and(dNear.greaterThanEqual(R.mul(1 - BAND)))
      .and(pick(bushType).lessThan(0.5).or(dist.lessThan(BUSH_FAR)));
    const cx = select(vertexIndex.equal(1).or(vertexIndex.equal(2)), float(1), float(0)).toVar();
    const cy = select(vertexIndex.equal(2).or(vertexIndex.equal(3)), float(1), float(0)).toVar();
    const right = vec3(dir.z, 0, dir.x.negate()).add(vec3(1e-4, 0, 0)).normalize();
    const up = cross(dir, right);
    const flip = h.greaterThan(0.5);
    vUv.assign(vec2(select(flip, cx.oneMinus(), cx), cy.oneMinus()));
    vTile.assign(typeOf.add(j.mul(n)));
    const w = fw.mul(s).mul(grow), hh = fh.mul(s).mul(grow);
    const p = pivot.add(right.mul(cx.sub(0.5).mul(w))).add(up.mul(cy.sub(0.5).mul(hh)));
    if (!toSun) {
      vElev.assign(j.mul(ELEVATIONS[1]));
      vRight.assign(select(flip, right.negate(), right));
      vUp.assign(up);
      vDir.assign(dir);
      vTint.assign(h.mul(0.35).add(0.8));
      vAutumn.assign(select(pick(tex.leafLayer).equal(3), float(0), autumnOf(iB.w))); // (pines stay green)
      // the shadow map looked up on its sun side, past its own caster quad (billboards.ts vShadowPos)
      vShadowPos.assign(curve(p.add(sunDir.mul(w.add(hh).mul(0.5)))));
    }
    return select(show, curve(p), vec3(0));
  })();
  const dithered = shading.taa && IMP_DITHER;
  const impMat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: dithered ? 0.5 : IMPOSTOR_CUT });
  const row = vTile.div(cols).floor(), col = vTile.sub(row.mul(cols));
  const uv = vUv.add(vec2(col, row)).div(vec2(cols, rows));
  const t = texture(atlas.texture, uv), nt = texture(atlas.normals, uv).xyz;
  const c = cos(vElev.mul(deg)), sn = sin(vElev.mul(deg));
  const nWorld = vRight.mul(nt.x).add(vUp.mul(nt.y.mul(c).sub(nt.z.mul(sn)))).add(vDir.mul(nt.y.mul(sn).add(nt.z.mul(c))));
  impMat.normalNode = normalize(cameraViewMatrix.mul(vec4(nWorld.add(vDir.mul(1e-3)), 0)).xyz);
  const gain = mix(pick3(VARIANTS.map((v) => v.impGain.side)), pick3(VARIANTS.map((v) => v.impGain.top)), vElev.div(90));
  const green = t.rgb.div(max(t.a, 1e-3)).mul(vec3(vTint.mul(0.92), vTint, vTint.mul(0.8))).mul(gain);
  const colour = autumnColour(green, vAutumn, smoothstep(0, 0.03, green.g.sub(max(green.r, green.b))));
  // the holes: the atlas cells of the mip a pixel samples (about a pixel each), kept with the chance vCov, each tree
  // its own pattern (billboards.ts holes: by the moving dither, TAA smudged it)
  const texel = vUv.mul(vec2(TILE_W, TILE_H));
  const lod = clamp(log2(max(length(dFdx(texel)), length(dFdy(texel)))).add(mipBias), 0, atlas.coverage.levels - 1.001);
  const cell = texel.div(exp2(lod.round())).floor();
  const holes = (cov: Float) => hash(uint(cell.x).add(uint(cell.y).mul(4099)).add(uint(vSeed).mul(1048573))).lessThan(cov);
  const kept = (cov: Float): Float => select(fadeKeep(vCode).and(holes(cov)), float(1), float(0));
  // the cut-out's alpha scaled per mip so a tile keeps its coverage (impostorCoverage's scales, billboards.ts scaleOf;
  // as a texture: the 360 floats as a uniform array are more than a WebGL 2 fragment shader is sure to have)
  const L = atlas.coverage.levels;
  const scaleTex = new THREE.DataTexture(atlas.coverage.scales, L, atlas.coverage.scales.length / L, THREE.RedFormat, THREE.FloatType);
  scaleTex.needsUpdate = true;
  const scaleAt = (lv: Float): Float => textureLoad(scaleTex, ivec2(int(lv), int(vTile.round()))).x;
  const cutAlpha = t.a.mul(mix(scaleAt(lod.floor()), scaleAt(lod.floor().add(1)), lod.fract()));
  // (under TAA each pixel drawn with the probability of its coverage against the moving dither, which TAA averages;
  // without, the cut-out by the scaled alpha)
  const alpha = dithered ? select(t.a.mul(IMP_COV).greaterThan(ditherAlt(screenCoordinate.xy)), float(1), float(0)) : cutAlpha;
  const shade = withDebug(colour, colour.mul(0.12));
  impMat.colorNode = vec4(shade.colour, alpha.mul(kept(vCov)));
  setEmissive(impMat, shade.emissive);
  impMat.positionNode = quadPosition(false);
  impMat.receivedShadowNode = shading.impShadow;
  impMat.receivedShadowPositionNode = vShadowPos;
  // the shadow casters: the same quads turned to the sun, into the shadow map only (a cell's mesh each, sharing its
  // quads; culled by the shadow camera's frustum)
  const shadowMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: IMPOSTOR_CUT });
  shadowMat.positionNode = quadPosition(true);
  shadowMat.colorNode = vec4(1, 1, 1, cutAlpha.mul(select(fadeKeep(vCode), float(1), float(0)))); // (no holes: as billboards.ts's)
  const quad = (): THREE.InstancedBufferGeometry => {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  };
  // 1 km cells, trees and bushes apart (the bushes' only near)
  interface Bucket { mesh: THREE.Mesh; caster: THREE.Mesh; x: number; y: number; z: number; r: number; bush: boolean; count: number }
  const buckets: Bucket[] = [];
  const lists = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const bush = isBush(VARIANTS[inst.b[i * 4 + 2]]) ? 1 : 0;
    const k = key(Math.floor(inst.a[i * 4] / BUCKET), Math.floor(inst.a[i * 4 + 2] / BUCKET)) * 2 + bush;
    const l = lists.get(k);
    if (l) l.push(i); else lists.set(k, [i]);
  }
  let seed = 12345;
  const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const fwMax = Math.max(...atlas.frames.map((f) => f.w)) * Math.max(...GROW) * 1.3; // (a big tree's quad, m)
  for (const [k, l] of lists) {
    for (let j = l.length - 1; j > 0; j--) {
      const r = Math.floor(rnd() * (j + 1));
      [l[j], l[r]] = [l[r], l[j]];
    }
    const A = new Float32Array(l.length * 4), B = new Float32Array(l.length * 4);
    l.forEach((i, j) => {
      A.set(inst.a.subarray(i * 4, i * 4 + 4), j * 4);
      B.set(inst.b.subarray(i * 4, i * 4 + 4), j * 4);
      B[j * 4 + 2] += (j / l.length) * 0.499; // (its rank, in the type's fraction)
    });
    const g = quad();
    g.setAttribute('iA', new THREE.InstancedBufferAttribute(A, 4));
    g.setAttribute('iB', new THREE.InstancedBufferAttribute(B, 4));
    g.instanceCount = l.length;
    const mesh = new THREE.Mesh(g, impMat);
    setLevel(mesh, 1, 1);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.name = 'webgl-impostors';
    group.add(mesh);
    const caster = new THREE.Mesh(g, shadowMat);
    caster.frustumCulled = false;
    caster.castShadow = true;
    caster.layers.set(1); // only the shadow camera renders it (lighting.ts)
    caster.name = 'webgl-impostor-shadows';
    group.add(caster);
    const cell = Math.floor(k / 2);
    const bx = (Math.floor(cell / 8192) - 4096 + 0.5) * BUCKET, bz = ((cell % 8192) - 4096 + 0.5) * BUCKET;
    buckets.push({ mesh, caster, x: bx, y: heightAt(bx, bz), z: bz, r: BUCKET * 0.75, bush: k % 2 === 1, count: l.length });
  }

  const frustum = new THREE.Frustum(), shadowFrustum = new THREE.Frustum(), m4 = new THREE.Matrix4(), sphere = new THREE.Sphere(), castSphere = new THREE.Sphere();
  // (how far a tall tree's shadow reaches across ground 60 m lower: m)
  const castLen = (Math.max(...trees.map((t) => t.height)) * 1.3 + 60) / Math.max(0.1, shading.sunDir.y);
  let impostors = 0;
  const lastScan = new THREE.Vector3(1e9, 0, 0);
  return {
    group,
    /** The bark material (instanced iA / iB like the trees): the statues' too (src/webgl/statues.ts). */
    barkMat: nearTrees.barkMat,
    /**
     * Per frame: the near scan when the camera has moved, the impostor cells in view (and in the shadow camera's:
     * `shadowCam`, null when there's no shadow pass), the projection scale.
     */
    update(camera: THREE.PerspectiveCamera, heightPx: number, fogFar: number, shadowCam: THREE.Camera | null): void {
      if (camera.position.distanceTo(lastScan) > 3) {
        nearTrees.scan(camera.position, scale);
        nearCentre.value.copy(camera.position);
        lastScan.copy(camera.position);
      }
      projScale.value = heightPx / (2 * Math.tan((camera.fov * deg) / 2));
      frustum.setFromProjectionMatrix(m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      if (shadowCam) shadowFrustum.setFromProjectionMatrix(m4.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse));
      impostors = 0;
      const p = camera.position;
      for (const b of buckets) {
        const d = Math.hypot(b.x - p.x, b.z - p.z);
        // (the cell round its middle's ground, lowered by the curvature; hills and trees within its margin)
        sphere.center.set(b.x, b.y + 30 - dropAtCPU(b.x, b.z, p.x, p.z), b.z);
        sphere.radius = b.r + 250;
        const shown = d - b.r < (b.bush ? BUSH_FAR : fogFar);
        b.mesh.visible = shown && frustum.intersectsSphere(sphere);
        // casters where the shadow map is and where their shadows can land in the view (the cell grown by a tall
        // tree's shadow onto ground 60 m lower, as chunks.ts CastTest): the map is a square round where the camera
        // looks, and drawing every cell in it cost 3.6 ms on the dev GPU at d1100
        b.caster.visible = shown && CASTERS && Boolean(shadowCam) && shadowFrustum.intersectsSphere(sphere) && (b.mesh.visible || frustum.intersectsSphere(castSphere.set(sphere.center, sphere.radius + castLen)));
        if (!b.mesh.visible && !b.caster.visible) continue;
        // the share kept at the nearest edge (MIN_PX in the shader): the rest is never drawn
        const near = Math.max(1, Math.hypot(Math.max(0, d - b.r), p.y - b.y));
        const share = Math.min(1, ((fwMax * projScale.value) / near / MIN_PX) ** 2);
        const geo = b.mesh.geometry as THREE.InstancedBufferGeometry;
        geo.instanceCount = Math.ceil(b.count * share);
        if (b.mesh.visible) impostors += geo.instanceCount;
      }
    },
    stats: () => ({ instances: nearTrees.count(), impostors }),
    /** The detail level (the menu's error threshold, tau): the geometry's radii x 1 / sqrt(tau), rescanned. */
    setDetail(tau: number): void {
      scale = nearScale.value = Math.min(1.5, Math.max(0.25, 1 / Math.sqrt(tau)));
      lastScan.set(1e9, 0, 0);
    },
    treeCount: inst.trees,
    bushCount: count - inst.trees,
  };
}
