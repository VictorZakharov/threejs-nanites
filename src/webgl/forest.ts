// The WebGL mode's forest (issue #39): what three's WebGL 2 backend can draw without compute, storage buffers,
// atomics or indirect draws. Near trees are src/webgl/near.ts (fixed DAG cuts, instanced, picked by distance on the
// CPU); the rest are the impostors from the same baked atlas, one instanced quad per tree in 1 km cells that the CPU
// culls by frustum and fog, sharing the pixels with the near trees over the last level's band. No occlusion, no
// software rasterizer, no splats. The statues are src/webgl/statues.ts, with the near trees' bark material.
import * as THREE from 'three/webgpu';
import {
  Fn, cameraPosition, cameraViewMatrix, clamp, cross, float, fract, mix, normalize, select, sin, smoothstep, texture,
  uniform, varying, vec2, vec3, vec4, vertexIndex, asin, cos, max, length,
} from 'three/tsl';
import { curve, dropAtCPU } from '../planet.ts';
import { heightAt } from '../terrain.ts';
import { ELEVATIONS, atlasLayout, IMPOSTOR_CUT, type ImpostorAtlas } from '../impostors.ts';
import { GROW } from '../nanite/billboards.ts';
import { autumnOf, autumnColour } from '../autumn.ts';
import { isBush, VARIANTS, type BuiltTree } from '../trees.ts';
import { setEmissive } from '../three-gaps.ts';
import { isTouchDevice } from '../touch.ts';
import { iA, iB, typeOf, pick, jitter, hashOf, BAND, fadeKeep } from './instanced.ts';
import { createNearTrees, NEAR_R, type NearTextures } from './near.ts';
import type { TreeInstances } from '../placement.ts';
import type { Float, Vec3 } from '../types.ts';

const params = new URLSearchParams(location.search);
const TOUCH = isTouchDevice(params);
const BUSH_FAR = Number(params.get('glbushes') ?? (TOUCH ? 350 : 700)); // m: bushes' impostors out to here
const BUCKET = 1024; // m: the impostors' cells
const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + cz + 4096; // (a cell's map key)
const MIN_PX = 2; // (impostors never narrower: smaller ones enlarged, a matching share dropped)
const deg = Math.PI / 180;

/** `treeShadow`: the trees' received shadow (lighting.ts makeFadeShadow); `impShadow` the impostors'. */
export function createWebGLForest(trees: BuiltTree[], inst: TreeInstances, tex: NearTextures, atlas: ImpostorAtlas, shading: {
  treeShadow: () => THREE.Node; impShadow: () => THREE.Node;
  wind: { time: THREE.UniformNode<'float', number>; wind: THREE.UniformNode<'float', number> }; // (the clock, the switch)
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
  const bushType = VARIANTS.map((v) => (isBush(v) ? 1 : 0));
  const impPosition = Fn(() => {
    const s = iA.w;
    const fw = pick(atlas.frames.map((f) => f.w)), fh = pick(atlas.frames.map((f) => f.h)); // (filled by the bake)
    const pivot = iA.xyz.add(vec3(0, fh.mul(s).mul(0.5), 0));
    const toCam = cameraPosition.sub(pivot);
    const dist = max(length(toCam), 0.1);
    const dir = toCam.div(dist);
    const elev = asin(clamp(dir.y, -1, 1)).div(deg);
    const j = clamp(elev.div(ELEVATIONS[1]).round(), 0, ELEVATIONS.length - 1).toVar(); // (the nearest tile)
    const grow = GROW.slice(0, -1).reduceRight<Float>((acc, g, i) => select(j.equal(i), float(g), acc), float(GROW[GROW.length - 1])).toVar();
    const h = hashOf(iA);
    const wPx = fw.mul(s).mul(grow).mul(projScale).div(dist);
    // (MIN_PX: a tree's rank in its cell, shuffled, against the share that keeps the coverage; the CPU draws only
    // the cell's first ones, up to the share at its nearest edge)
    const keep = select(wPx.lessThan(MIN_PX), fract(iB.z).mul(2).lessThan(wPx.div(MIN_PX).pow(2)), wPx.greaterThan(-1)).toVar();
    grow.mulAssign(max(float(MIN_PX).div(max(wPx, 1e-3)), 1));
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
    vElev.assign(j.mul(ELEVATIONS[1]));
    vRight.assign(select(flip, right.negate(), right));
    vUp.assign(up);
    vDir.assign(dir);
    vTint.assign(h.mul(0.35).add(0.8));
    vAutumn.assign(select(pick(tex.leafLayer).equal(3), float(0), autumnOf(iB.w))); // (pines stay green)
    const w = fw.mul(s).mul(grow), hh = fh.mul(s).mul(grow);
    const p = pivot.add(right.mul(cx.sub(0.5).mul(w))).add(up.mul(cy.sub(0.5).mul(hh)));
    return select(show, curve(p), vec3(0));
  })();
  const impMat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: IMPOSTOR_CUT });
  const row = vTile.div(cols).floor(), col = vTile.sub(row.mul(cols));
  const uv = vUv.add(vec2(col, row)).div(vec2(cols, rows));
  const t = texture(atlas.texture, uv), nt = texture(atlas.normals, uv).xyz;
  const c = cos(vElev.mul(deg)), sn = sin(vElev.mul(deg));
  const nWorld = vRight.mul(nt.x).add(vUp.mul(nt.y.mul(c).sub(nt.z.mul(sn)))).add(vDir.mul(nt.y.mul(sn).add(nt.z.mul(c))));
  impMat.normalNode = normalize(cameraViewMatrix.mul(vec4(nWorld.add(vDir.mul(1e-3)), 0)).xyz);
  const gain = mix(pick3(VARIANTS.map((v) => v.impGain.side)), pick3(VARIANTS.map((v) => v.impGain.top)), vElev.div(90));
  const green = t.rgb.div(max(t.a, 1e-3)).mul(vec3(vTint.mul(0.92), vTint, vTint.mul(0.8))).mul(gain);
  const colour = autumnColour(green, vAutumn, smoothstep(0, 0.03, green.g.sub(max(green.r, green.b))));
  // (the alpha a little fuller from afar: the far mips' leaves are averaged into a haze the cut-out would thin)
  impMat.colorNode = vec4(colour, t.a.mul(1.25).mul(select(fadeKeep(vCode), float(1), float(0))));
  setEmissive(impMat, colour.mul(0.12));
  impMat.positionNode = impPosition;
  impMat.receivedShadowNode = shading.impShadow;
  const quad = (): THREE.InstancedBufferGeometry => {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  };
  // 1 km cells, trees and bushes apart (the bushes' only near)
  interface Bucket { mesh: THREE.Mesh; x: number; y: number; z: number; r: number; bush: boolean; count: number }
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
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.name = 'webgl-impostors';
    group.add(mesh);
    const cell = Math.floor(k / 2);
    const bx = (Math.floor(cell / 8192) - 4096 + 0.5) * BUCKET, bz = ((cell % 8192) - 4096 + 0.5) * BUCKET;
    buckets.push({ mesh, x: bx, y: heightAt(bx, bz), z: bz, r: BUCKET * 0.75, bush: k % 2 === 1, count: l.length });
  }

  const frustum = new THREE.Frustum(), m4 = new THREE.Matrix4(), sphere = new THREE.Sphere();
  let impostors = 0;
  const lastScan = new THREE.Vector3(1e9, 0, 0);
  return {
    group,
    /** The bark material (instanced iA / iB like the trees): the statues' too (src/webgl/statues.ts). */
    barkMat: nearTrees.barkMat,
    /** Per frame: the near scan when the camera has moved, the impostor cells in view, the projection scale. */
    update(camera: THREE.PerspectiveCamera, heightPx: number, fogFar: number): void {
      if (camera.position.distanceTo(lastScan) > 3) {
        nearTrees.scan(camera.position, scale);
        nearCentre.value.copy(camera.position);
        lastScan.copy(camera.position);
      }
      projScale.value = heightPx / (2 * Math.tan((camera.fov * deg) / 2));
      frustum.setFromProjectionMatrix(m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      impostors = 0;
      const p = camera.position;
      for (const b of buckets) {
        const d = Math.hypot(b.x - p.x, b.z - p.z);
        // (the cell round its middle's ground, lowered by the curvature; hills and trees within its margin)
        sphere.center.set(b.x, b.y + 30 - dropAtCPU(b.x, b.z, p.x, p.z), b.z);
        sphere.radius = b.r + 250;
        b.mesh.visible = d - b.r < (b.bush ? BUSH_FAR : fogFar) && frustum.intersectsSphere(sphere);
        if (!b.mesh.visible) continue;
        // the share kept at the nearest edge (MIN_PX in the shader): the rest is never drawn
        const near = Math.max(1, Math.hypot(Math.max(0, d - b.r), p.y - b.y));
        const share = Math.min(1, ((fwMax * projScale.value) / near / MIN_PX) ** 2);
        const geo = b.mesh.geometry as THREE.InstancedBufferGeometry;
        geo.instanceCount = Math.ceil(b.count * share);
        impostors += geo.instanceCount;
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
