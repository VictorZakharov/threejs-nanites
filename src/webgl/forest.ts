// The WebGL mode's forest (issue #39): what three's WebGL 2 backend can draw without compute, storage buffers,
// atomics or indirect draws. Near trees are instanced meshes at a few fixed cuts of their cluster DAG, chosen on the
// CPU by distance (a 64 m grid of the instances, rescanned when the camera has moved); the rest are the impostors
// from the same baked atlas, one instanced quad per tree in 1 km cells that the CPU culls by frustum and fog. No
// occlusion, no software rasterizer, no splats, no wind; the statues aren't drawn.
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, cameraPosition, cameraViewMatrix, clamp, cross, dot, float, fract, mix, normalize, positionLocal,
  normalLocal, normalViewGeometry, select, sin, smoothstep, texture, uniform, varying, vec2, vec3, vec4, vertexIndex, asin, cos, max, length,
} from 'three/tsl';
import { curve, dropAtCPU } from '../planet.ts';
import { heightAt } from '../terrain.ts';
import { ELEVATIONS, atlasLayout, dagCut, IMPOSTOR_CUT, type ImpostorAtlas } from '../impostors.ts';
import { GROW } from '../nanite/billboards.ts';
import { barkColour, leafColour, makeLeafAlpha } from '../nanite/shading.ts';
import { autumnOf, autumnColour } from '../autumn.ts';
import { isBush, isModel, VARIANTS, type BuiltTree } from '../trees.ts';
import { setEmissive } from '../three-gaps.ts';
import { isTouchDevice } from '../touch.ts';
import type { TreeInstances } from '../placement.ts';
import type { Float, Vec3, Vec4 } from '../types.ts';

const params = new URLSearchParams(location.search);
const TOUCH = isTouchDevice(params);
/**
 * The geometry levels: out to `r` metres (x the tree's jitter, 0.85..1.15), the DAG cut a tree has when it's `px`
 * pixels tall at tau 1; past the last, impostors. (?glnear=r0,r1: the radii)
 */
const RADII = (params.get('glnear') ?? (TOUCH ? '35,110' : '60,220')).split(',').map(Number);
const PX = TOUCH ? [90, 25] : [160, 45];
const LEVELS = RADII.map((r, k) => ({ r, px: PX[k] ?? PX[PX.length - 1] }));
const NEAR_MAX = RADII[RADII.length - 1] * 1.15; // (at detail 1: see setDetail)
const BUSH_FAR = Number(params.get('glbushes') ?? (TOUCH ? 350 : 700)); // m: bushes' impostors out to here
const CELL = 64, BUCKET = 1024; // m: the near scan's grid, the impostors' cells
const MIN_PX = 2; // (impostors never narrower: smaller ones enlarged, a matching share dropped)
const deg = Math.PI / 180;

/** The tree's own spread of the level radii (CPU and shader alike, from its scale). */
const jitterCPU = (s: number): number => 0.85 + 0.3 * (((s * 97.13) % 1) + 1) % 1;
const jitter = (s: Float): Float => fract(s.mul(97.13)).mul(0.3).add(0.85);
/** A per-tree random number from its position (float maths: no 32-bit integer hash needed). */
const hashOf = (a: Vec4): Float => fract(sin(dot(fract(a.xz.mul(0.0137)), vec2(12.9898, 78.233))).mul(43758.5453));
const rotY = (v: Vec3, b: Vec4): Vec3 => vec3(v.x.mul(b.x).sub(v.z.mul(b.y)), v.y, v.x.mul(b.y).add(v.z.mul(b.x)));

export interface WebGLForestTextures {
  bark: THREE.DataArrayTexture;
  leaf: THREE.DataArrayTexture;
  barkLayer: number[]; // per variant
  leafLayer: number[];
}

/** `fade(shadow)`: the trees' received shadow (lighting.ts makeFadeShadow); `impShadow` the impostors'. */
export function createWebGLForest(trees: BuiltTree[], inst: TreeInstances, tex: WebGLForestTextures, atlas: ImpostorAtlas, shading: {
  treeShadow: () => THREE.Node; impShadow: () => THREE.Node;
}) {
  const group = new THREE.Group();
  group.name = 'webgl-forest';
  const count = inst.a.length / 4 - inst.statues;
  const nearCentre = uniform(new THREE.Vector3(1e9, 0, 0)); // (where the near scan was made: the impostors leave those out)
  const projScale = uniform(1); // pixels per metre at 1 m
  const nearScale = uniform(1); // the level radii's scale (setDetail)
  let scale = 1;
  const iA = attribute<'vec4'>('iA', 'vec4'), iB = attribute<'vec4'>('iB', 'vec4');
  // (the cells' copies hold the tree's rank in the fraction, under 0.5, see the cells below; +0.25: interpolated into
  // the fragment stage, 3 can arrive as 2.9999, and the trunks were speckled with another type's bark)
  const typeOf = iB.z.add(0.25).floor();
  /** The tree's type's value from a list (a select chain: one shader for every type). */
  const pick = (values: number[]): Float => values.slice(0, -1).reduceRight<Float>((acc, v, i) => select(typeOf.equal(i), float(v), acc), float(values[values.length - 1]));

  // ------------------------------------------------------------------ near trees: fixed DAG cuts, instanced
  // (the normal turned with the tree, as draw.ts does; leaves keep it on both faces: flipped, back faces went black)
  const treeVertex = (): { position: Vec3; normal: Vec3 } => ({
    position: Fn(() => {
      normalLocal.assign(rotY(attribute<'vec3'>('normal', 'vec3'), iB));
      return curve(rotY(positionLocal, iB).mul(iA.w).add(iA.xyz));
    })(),
    normal: normalViewGeometry,
  });
  const leafAlpha = makeLeafAlpha(tex.leaf, attribute('uv', 'vec2'));
  const tint = (): Float => hashOf(iA).mul(0.35).add(0.8);
  interface Slot { a: THREE.InstancedBufferAttribute; b: THREE.InstancedBufferAttribute; geos: THREE.InstancedBufferGeometry[]; n: number }
  const slots: Slot[][] = trees.map(() => []);
  // (one bark and one leaf material for all: WebGL compiles each program on the main thread, ~0.15 s each)
  const barkMat = barkMaterial(), leafMat = leafMaterial();
  trees.forEach((t, v) => {
    if (isModel(t.variant)) return;
    LEVELS.forEach((L, k) => {
      const cap = Math.ceil((Math.PI * (L.r * 1.15 * 1.5) ** 2) / 81 * (isBush(t.variant) ? 3 : 1.5)) + 64;
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const b = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const cut = dagCut(t, t.height / L.px);
      const geos = ([cut.bark, cut.leaves] as const).map((part, kind) => {
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(part.pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(part.nrm, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(part.uv, 2));
        g.setIndex(new THREE.BufferAttribute(part.idx, 1));
        g.setAttribute('iA', a);
        g.setAttribute('iB', b);
        g.instanceCount = 0;
        if (part.idx.length) {
          const mesh = new THREE.Mesh(g, kind === 0 ? barkMat : leafMat);
          mesh.frustumCulled = false;
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.layers.enable(1); // (the shadow camera's layer: lighting.ts)
          mesh.name = `webgl-${kind ? 'leaves' : 'bark'}-${v}-${k}`;
          group.add(mesh);
        }
        return g;
      });
      slots[v][k] = { a, b, geos, n: 0 };
    });
  });

  function barkMaterial(): THREE.MeshLambertNodeMaterial {
    const layer = pick(tex.barkLayer);
    const m = new THREE.MeshLambertNodeMaterial();
    const { position, normal } = treeVertex();
    m.positionNode = position;
    m.normalNode = normal;
    m.colorNode = vec4(barkColour(texture(tex.bark, attribute('uv', 'vec2')).depth(layer).rgb).mul(tint()), 1);
    m.receivedShadowNode = shading.treeShadow;
    return m;
  }
  function leafMaterial(): THREE.MeshLambertNodeMaterial {
    const layer = pick(tex.leafLayer).toVar(); // (a var: uint() of the select chain itself lost its conversion in GLSL)
    const m = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
    const { position, normal } = treeVertex();
    m.positionNode = position;
    m.normalNode = normal;
    const l = texture(tex.leaf, attribute('uv', 'vec2')).depth(layer);
    m.colorNode = vec4(leafColour(l.rgb, layer, tint(), autumnOf(iB.w)), leafAlpha(l.a, layer));
    m.receivedShadowNode = shading.treeShadow;
    return m;
  }

  // the near scan's grid: instance indices by 64 m cell
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + cz + 4096;
  for (let i = 0; i < count; i++) {
    const k = key(Math.floor(inst.a[i * 4] / CELL), Math.floor(inst.a[i * 4 + 2] / CELL));
    const l = grid.get(k);
    if (l) l.push(i); else grid.set(k, [i]);
  }
  let near = 0;
  /** Puts every instance within NEAR_MAX of `p` into its level's instanced meshes. */
  function scanNear(p: THREE.Vector3): void {
    for (const l of slots) for (const s of l) if (s) s.n = 0;
    near = 0;
    const reach = NEAR_MAX * scale;
    if (Math.abs(p.y - heightAt(p.x, p.z)) > reach) return void (nearCentre.value.copy(p), finishScan());
    const c0x = Math.floor((p.x - reach) / CELL), c1x = Math.floor((p.x + reach) / CELL);
    const c0z = Math.floor((p.z - reach) / CELL), c1z = Math.floor((p.z + reach) / CELL);
    const A = inst.a, B = inst.b;
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      for (const i of grid.get(key(cx, cz)) ?? []) {
        const d = Math.hypot(A[i * 4] - p.x, A[i * 4 + 1] - p.y, A[i * 4 + 2] - p.z), j = jitterCPU(A[i * 4 + 3]);
        const k = LEVELS.findIndex((L) => d < L.r * j * scale);
        const s = k < 0 ? undefined : slots[Math.floor(B[i * 4 + 2])][k];
        if (!s || s.n * 4 >= s.a.array.length) continue;
        (s.a.array as Float32Array).set(A.subarray(i * 4, i * 4 + 4), s.n * 4);
        (s.b.array as Float32Array).set(B.subarray(i * 4, i * 4 + 4), s.n * 4);
        s.n++;
        near++;
      }
    }
    finishScan();
    nearCentre.value.copy(p);
  }
  function finishScan(): void {
    for (const l of slots) for (const s of l) if (s) {
      s.a.clearUpdateRanges(); s.b.clearUpdateRanges();
      s.a.addUpdateRange(0, s.n * 4); s.b.addUpdateRange(0, s.n * 4);
      s.a.needsUpdate = s.b.needsUpdate = true;
      for (const g of s.geos) g.instanceCount = s.n;
    }
  }

  // ------------------------------------------------------------------ far trees: impostors
  const n = trees.length;
  const { cols, rows } = atlasLayout(n);
  const pick3 = (values: number[][]): Vec3 => vec3(pick(values.map((c) => c[0])), pick(values.map((c) => c[1])), pick(values.map((c) => c[2])));
  const vUv = varying(vec2(0), 'vGlUv'), vTile = varying(float(0), 'vGlTile'), vElev = varying(float(0), 'vGlElev');
  const vRight = varying(vec3(1, 0, 0), 'vGlRight'), vUp = varying(vec3(0, 1, 0), 'vGlUp'), vDir = varying(vec3(0, 0, 1), 'vGlDir');
  const vTint = varying(float(1), 'vGlTint'), vAutumn = varying(float(0), 'vGlAutumn');
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
    const dNear = length(iA.xyz.sub(nearCentre));
    const show = keep.and(dNear.greaterThanEqual(jitter(s).mul(LEVELS[LEVELS.length - 1].r).mul(nearScale)))
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
  impMat.colorNode = vec4(colour, t.a.mul(1.25));
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
    /** Per frame: the near scan when the camera has moved, the impostor cells in view, the projection scale. */
    update(camera: THREE.PerspectiveCamera, heightPx: number, fogFar: number): void {
      if (camera.position.distanceTo(lastScan) > 3) (scanNear(camera.position), lastScan.copy(camera.position));
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
    stats: () => ({ instances: near, impostors }),
    /** The detail level (the menu's error threshold, tau): the geometry's radii x 1 / sqrt(tau), rescanned. */
    setDetail(tau: number): void {
      scale = nearScale.value = Math.min(1.5, Math.max(0.25, 1 / Math.sqrt(tau)));
      lastScan.set(1e9, 0, 0);
    },
    treeCount: inst.trees,
    bushCount: count - inst.trees,
  };
}
