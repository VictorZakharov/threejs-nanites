// The WebGL mode's near trees (src/webgl/forest.ts has the impostors past them): instanced meshes at a few fixed cuts
// of each type's cluster DAG, chosen on the CPU by distance (a 64 m grid of the instances, rescanned when the camera
// has moved). Over a band round each level's radius a tree is drawn at both levels, the pixels split between them by
// a dither (instanced.ts fadeCode), so it doesn't pop from one cut to the next; at the last radius it fades into its
// impostor the same way. The materials sway like draw.ts's (_vertex's wind).
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, clamp, dot, float, normalLocal, normalViewGeometry, positionLocal, select, sin, texture, varying, vec2, vec3, vec4,
  cameraProjectionMatrix, cameraViewMatrix, mrt,
} from 'three/tsl';
import { curve } from '../planet.ts';
import { heightAt } from '../terrain.ts';
import { dagCut } from '../impostors.ts';
import { barkColour, leafColour, makeLeafAlpha, a2cDither, LEAF_DITHER } from '../nanite/shading.ts';
import { autumnOf } from '../autumn.ts';
import { isBush, isModel, type BuiltTree } from '../trees.ts';
import { setEmissive } from '../three-gaps.ts';
import { isTouchDevice } from '../touch.ts';
import { withDebug, setLevel } from './debug.ts';
import { iA, iB, typeOf, pick, jitterCPU, hashOf, rotY, BAND, across, fadeCode, fadeKeep } from './instanced.ts';
import type { TreeInstances } from '../placement.ts';
import type { Float, Vec3 } from '../types.ts';

const params = new URLSearchParams(location.search);
const TOUCH = isTouchDevice(params);
/**
 * The levels: out to `r` metres (x the tree's jitter, 0.85..1.15, and the detail's scale), the DAG cut a tree has
 * when it's `px` pixels tall at tau 1; past the last, impostors. A 20 m tree is ~640 px x 20 / d tall at 1080p, so
 * each level's cut is about right at its inner radius (?glnear=r0,r1,...: the radii; ?glpx=: the cuts). With two (60 m at 160 px), a
 * trunk a few metres away was drawn at the cut for 160 px: smeared, its branches square.
 */
const RADII = (params.get('glnear') ?? (TOUCH ? '10,35,110' : '12,30,80,180')).split(',').map(Number);
const PX = (params.get('glpx') ?? (TOUCH ? '400,90,25' : '1000,350,120,40')).split(',').map(Number);
export const LEVELS = RADII.map((r, k) => ({ r, px: PX[k] ?? PX[PX.length - 1] }));
/** The last level's radius (the impostors take over across its band). */
export const NEAR_R = RADII[RADII.length - 1];
const CELL = 64; // m: the scan's grid

export interface NearTextures {
  bark: THREE.DataArrayTexture;
  leaf: THREE.DataArrayTexture;
  barkLayer: number[]; // per variant
  leafLayer: number[];
}

export function createNearTrees(trees: BuiltTree[], inst: TreeInstances, tex: NearTextures, group: THREE.Group, shading: {
  treeShadow: () => THREE.Node;
  wind: { time: THREE.UniformNode<'float', number>; prevTime: THREE.UniformNode<'float', number>; wind: THREE.UniformNode<'float', number> };
  taa: boolean; // (under TAA: the leaves' alpha dithered by coverage, the wind's motion written for the resolve)
}) {
  const count = inst.a.length / 4 - inst.statues;
  // (the normal turned with the tree, as draw.ts does; leaves keep it on both faces: flipped, back faces went black)
  // wind as draw.ts's _vertex: the whole tree bends with height^2, leaves flutter on top; none for the statues
  const heightOf = pick(trees.map((t) => t.height)), windOf = pick(trees.map((t) => (isModel(t.variant) ? 0 : 1)));
  const vFade = varying(float(0), 'vGlFade'); // (the copy's cross-fade code: instanced.ts)
  const vClip = varying(vec4(0, 0, 0, 1), 'vGlClip'), vPrevClip = varying(vec4(0, 0, 0, 1), 'vGlPrevClip');
  const treeVertex = (leaf: boolean): Vec3 => Fn(() => {
    normalLocal.assign(rotY(attribute<'vec3'>('normal', 'vec3'), iB));
    vFade.assign(iB.z.sub(typeOf));
    const s = iA.w;
    const h = clamp(positionLocal.y.div(heightOf), 0, 1);
    const sway = shading.wind.wind.mul(windOf);
    const windAt = (time: Float): Vec3 => {
      const t = time.mul(1.1).add(iB.w);
      const gust = sin(t.add(iA.x.mul(0.013))).mul(0.6).add(sin(t.mul(2.7).add(iA.z.mul(0.021))).mul(0.25)).add(0.35);
      const bend = h.mul(h).mul(gust).mul(sway).mul(0.06).mul(heightOf).mul(s);
      let off: Vec3 = vec3(bend.mul(0.8), bend.mul(-0.15), bend.mul(0.6));
      if (leaf) {
        const fl = sin(time.mul(7.0).add(dot(positionLocal, vec3(1.7, 2.3, 1.1)))).mul(0.04).mul(sway).mul(s);
        off = off.add(vec3(fl, fl.mul(0.5), fl.mul(-0.7)));
      }
      return off;
    };
    const base = rotY(positionLocal, iB).mul(s).add(iA.xyz);
    const world = curve(base.add(windAt(shading.wind.time)));
    if (shading.taa) { // (the wind's motion on screen, for the TAA resolve: draw.ts's)
      const viewProj = cameraProjectionMatrix.mul(cameraViewMatrix);
      vClip.assign(viewProj.mul(vec4(world, 1)));
      vPrevClip.assign(viewProj.mul(vec4(curve(base.add(windAt(shading.wind.prevTime))), 1)));
    }
    return world;
  })();
  const motion = () => mrt({ wind: vec4(vClip.xy.div(vClip.w).sub(vPrevClip.xy.div(vPrevClip.w)).mul(vec2(0.5, -0.5)), 0, 1) });
  const leafAlpha = makeLeafAlpha(tex.leaf, attribute('uv', 'vec2'));
  const tint = (): Float => select(windOf.greaterThan(0.5), hashOf(iA).mul(0.35).add(0.8), float(1)); // (the statues' stone untinted)
  const keep = (): Float => select(fadeKeep(vFade), float(1), float(0));

  // (one bark and one leaf material for all: WebGL compiles each program on the main thread, ~0.15 s each)
  const barkMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, alphaTest: 0.5 }); // (as draw.ts)
  barkMat.positionNode = treeVertex(false);
  barkMat.normalNode = normalViewGeometry;
  const bark = withDebug(barkColour(texture(tex.bark, attribute('uv', 'vec2')).depth(pick(tex.barkLayer)).rgb).mul(tint()), vec3(0));
  barkMat.colorNode = vec4(bark.colour, keep());
  barkMat.emissiveNode = bark.emissive;
  barkMat.receivedShadowNode = shading.treeShadow;
  if (shading.taa) barkMat.mrtNode = motion();
  const leafMat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
  const layer = pick(tex.leafLayer).toVar(); // (a var: uint() of the select chain itself lost its conversion in GLSL)
  leafMat.positionNode = treeVertex(true);
  leafMat.normalNode = normalViewGeometry;
  const l = texture(tex.leaf, attribute('uv', 'vec2')).depth(layer);
  const col = leafColour(l.rgb, layer, tint(), autumnOf(iB.w));
  // (under TAA alpha to coverage against the moving dither, as draw.ts: a2cDither)
  const alpha = shading.taa && LEAF_DITHER ? a2cDither(leafAlpha(l.a, layer)) : leafAlpha(l.a, layer);
  const leaf = withDebug(col, col.mul(0.12)); // (emissive: light passing through the leaves, as draw.ts)
  leafMat.colorNode = vec4(leaf.colour, alpha.mul(keep()));
  setEmissive(leafMat, leaf.emissive);
  leafMat.receivedShadowNode = shading.treeShadow;
  if (shading.taa) leafMat.mrtNode = motion();

  interface Slot { a: THREE.InstancedBufferAttribute; b: THREE.InstancedBufferAttribute; geos: THREE.InstancedBufferGeometry[]; n: number }
  const slots: Slot[][] = trees.map(() => []);
  trees.forEach((t, v) => {
    if (isModel(t.variant)) return;
    let shared: Record<string, THREE.BufferAttribute> | null = null; // (every cut indexes the same vertices)
    LEVELS.forEach((L, k) => {
      // (the trees within the level's outer band, ~1 per 81 m2 at most, x1.5 for clumps; bushes ~3x)
      const outer = L.r * 1.15 * (1 + BAND), inner = k ? LEVELS[k - 1].r * 0.85 * (1 - BAND) : 0;
      const cap = Math.ceil((Math.PI * (outer ** 2 - inner ** 2)) / 81 * (isBush(t.variant) ? 4.5 : 2.25)) + 64;
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const b = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const cut = dagCut(t, t.height / L.px);
      shared ??= { position: new THREE.BufferAttribute(cut.bark.pos, 3), normal: new THREE.BufferAttribute(cut.bark.nrm, 3), uv: new THREE.BufferAttribute(cut.bark.uv, 2) };
      const geos = ([cut.bark, cut.leaves] as const).map((part, kind) => {
        const g = new THREE.InstancedBufferGeometry();
        for (const [name, attr] of Object.entries(shared!)) g.setAttribute(name, attr);
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
          setLevel(mesh, k, LEVELS.length);
          group.add(mesh);
        }
        return g;
      });
      slots[v][k] = { a, b, geos, n: 0 };
    });
  });

  // the scan's grid: instance indices by 64 m cell
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + cz + 4096;
  for (let i = 0; i < count; i++) {
    const k = key(Math.floor(inst.a[i * 4] / CELL), Math.floor(inst.a[i * 4 + 2] / CELL));
    const l = grid.get(k);
    if (l) l.push(i); else grid.set(k, [i]);
  }
  let near = 0;
  const put = (v: number, k: number, i: number, code: number): void => {
    const s = slots[v][k];
    if (!s || s.n * 4 >= s.a.array.length) return;
    (s.a.array as Float32Array).set(inst.a.subarray(i * 4, i * 4 + 4), s.n * 4);
    (s.b.array as Float32Array).set(inst.b.subarray(i * 4, i * 4 + 4), s.n * 4);
    (s.b.array as Float32Array)[s.n * 4 + 2] = v + code;
    s.n++;
  };
  /** Puts every instance within the last band of `p` into its level's meshes (in a band, both levels'). */
  function scan(p: THREE.Vector3, scale: number): void {
    for (const l of slots) for (const s of l) if (s) s.n = 0;
    near = 0;
    const reach = NEAR_R * 1.15 * (1 + BAND) * scale;
    if (Math.abs(p.y - heightAt(p.x, p.z)) <= reach) {
      const c0x = Math.floor((p.x - reach) / CELL), c1x = Math.floor((p.x + reach) / CELL);
      const c0z = Math.floor((p.z - reach) / CELL), c1z = Math.floor((p.z + reach) / CELL);
      const A = inst.a, B = inst.b;
      for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
        for (const i of grid.get(key(cx, cz)) ?? []) {
          const d = Math.hypot(A[i * 4] - p.x, A[i * 4 + 1] - p.y, A[i * 4 + 2] - p.z), j = jitterCPU(A[i * 4 + 3]) * scale;
          const k = LEVELS.findIndex((L) => d < L.r * j * (1 + BAND));
          if (k < 0) continue;
          const v = Math.floor(B[i * 4 + 2]), t = across(d, LEVELS[k].r * j);
          put(v, k, i, t > 0 ? fadeCode(t, true) : 0);
          if (t > 0 && k + 1 < LEVELS.length) put(v, k + 1, i, fadeCode(t, false)); // (the impostor takes the last band's other half)
          near++;
        }
      }
    }
    for (const l of slots) for (const s of l) if (s) {
      s.a.clearUpdateRanges(); s.b.clearUpdateRanges();
      s.a.addUpdateRange(0, s.n * 4); s.b.addUpdateRange(0, s.n * 4);
      s.a.needsUpdate = s.b.needsUpdate = true;
      for (const g of s.geos) g.instanceCount = s.n;
    }
  }
  return { barkMat, scan, count: () => near };
}
