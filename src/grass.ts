// Grass: blades drawn around the viewer in three rings, each over a grid of world-space cells that follows the
// camera (snapped to whole cells, so a blade stays where it is while you fly). Each ring has coarser cells and wider
// blades than the one inside it and they cross-fade by distance, so the covered fraction of the ground stays even;
// the outer ring thins out into the ground's own colour. A compute pass per ring (src/grass-keep.ts) decides each
// cell's blade: position and size from a hash of the cell, height from the terrain's own vertex heights (same
// triangles as the terrain mesh, so blades stand exactly on it), density from the canopy cover, the slope and patch
// noise; it lists the kept blades, and the ring is one indirect draw of them (the vertex shader shapes the blade and
// adds the wind). Blades gather in tufts (a jittered grid of clump centres in world space, so every ring agrees): a
// tuft's blades share a height and a dryness and fan out from its centre, and where grass is sparse it's whole tufts
// that are left, not lone blades evenly spread (on the forest floor those read as scattered green spikes). Blades
// bend along an arc, turn a little towards the viewer when seen edge-on and glow where the sun is behind them.
// Each ring's grid is split into TILES x TILES tiles, and only the cells of the tiles in view and in the ring are
// tested (on the CPU, per frame).
import * as THREE from 'three/webgpu';
import {
  Fn, instanceIndex, attribute, uniform, float, vec2, vec3, vec4, sin, cos, mix, clamp, smoothstep, varying,
  normalLocal, cameraProjectionMatrix, cameraViewMatrix, mrt, normalViewGeometry, abs, sign, storage,
} from 'three/tsl';
import { curve, viewerPos } from './planet.ts';
import { roadDistanceNode } from './road.ts';
import { BLADE, ARGS, patchAt, ringCapacity, buildKeepPass, makeGrassCounters, countersPasses, type KeepRing } from './grass-keep.ts';
import { computeBatch, uintAsFloat, unpackHalf, unpackUnorm4 } from './three-gaps.ts';
import type { Float, Vec2, Vec3 } from './types.ts';
import type { ForestUniforms } from './nanite/types.ts';

const params = new URLSearchParams(location.search);
const TILES = Number(params.get('grasstiles') ?? 8); // tiles a side per ring

/** The rings: cell size (m), outer radius (m) and segments per blade (2 x segs + 1 vertices, 2 x segs - 1 triangles:
 * the far rings' blades are a few pixels tall and need no curve, and most blades are there); each fades in over the
 * last 20% of the ring inside it. */
const TOUCH = matchMedia('(pointer: coarse)').matches;
const SCALE = Number(params.get('grass') ?? (TOUCH ? 0.5 : 1)); // ring radii, x (0 = no grass)
/** Blades per square metre, x (`?grassdense=`; the cells shrink by its root): 6 on desktops, 1 on touch screens. */
const DENSE = Number(params.get('grassdense') ?? (TOUCH ? 1 : 6));
const RINGS = [
  { cell: 0.09, radius: 16, segs: 4 },
  { cell: 0.2, radius: 40, segs: 3 },
  { cell: 0.45, radius: 90, segs: 2 },
  { cell: 1, radius: 200, segs: 1 },
].map((r) => ({ ...r, cell: r.cell / Math.sqrt(DENSE) }));

export interface GrassContext {
  terrain: THREE.Mesh; // the detailed terrain square (its vertex heights)
  size: number; // its side (m)
  segments: number;
  cover: { texture: THREE.Texture; extent: number }; // canopy cover (forestDensity)
  u: ForestUniforms; // time, prevTime, wind
  receivedShadow: unknown; // the ground's receivedShadowNode (map shadow fading into the far-field shade)
  sunDir: THREE.Vector3; // towards the sun
  renderer: THREE.WebGPURenderer; // (the keep passes)
}

/** Where the outermost ring's blades turn to the ground's colour (and the ground's darkening under them fades):
 * from the ring inside's radius to 80% of its own (m). */
const farSpan = (k: number): [number, number] => [RINGS[k - 1].radius * SCALE, RINGS[k].radius * SCALE * 0.8];
const shown = uniform(SCALE > 0 ? 1 : 0); // the grass is drawn (the menu's switch)

/**
 * The floor's meadow colour, x: darker where blades stand over it (the ground seen between them is in their shade;
 * lit as open ground it showed pale olive between the blades), back to 1 before the outer ring's edge (where the
 * blades thin out into the plain ground). `cover` the canopy cover, `dist` the distance to the camera.
 */
export function underGrass(p: Vec2, cover: Float, dist: Float): Float {
  if (!(SCALE > 0)) return float(1); // (no grass; smoothstep(0, 0, x) doesn't compile)
  const [from, to] = farSpan(RINGS.length - 1);
  const blades = smoothstep(0.1, 0.9, roadDistanceNode(p)).mul(float(1).sub(cover.mul(0.6))).mul(smoothstep(0.05, 0.45, patchAt(p)));
  return float(1).sub(blades.mul(float(1).sub(smoothstep(from, to, dist))).mul(shown).mul(0.5));
}

/** One blade: (t along it 0..1, side -1..1). Triangle strip as indexed triangles. */
function bladeGeometry(SEGS: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const bv: number[] = [], idx: number[] = [];
  for (let s = 0; s < SEGS; s++) bv.push(s / SEGS, -1, s / SEGS, 1);
  bv.push(1, 0);
  for (let s = 0; s < SEGS; s++) {
    const a = s * 2;
    idx.push(a, a + 1, a + 2);
    if (s < SEGS - 1) idx.push(a + 1, a + 3, a + 2);
  }
  geo.setAttribute('bv', new THREE.Float32BufferAttribute(bv, 2));
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(bv.length * 1.5), 3)); // (unused)
  geo.setIndex(idx);
  return geo;
}

export function createGrass(ctx: GrassContext) {
  const scale = SCALE;
  const group = new THREE.Group();
  group.name = 'grass';
  if (!(scale > 0)) return { group, update() {}, async stats() { return []; } };

  // terrain heights as a float texture: the terrain mesh's vertices, read back exactly
  const n = ctx.segments + 1;
  const pos = ctx.terrain.geometry.attributes.position;
  const heights = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) heights[i] = pos.getY(i);
  const heightTex = new THREE.DataTexture(heights, n, n, THREE.RedFormat, THREE.FloatType);
  heightTex.needsUpdate = true;
  const step = ctx.size / ctx.segments;
  const counters = makeGrassCounters(RINGS.map((r) => (r.segs * 2 - 1) * 3));
  const keepCtx = { heights: heightTex, size: ctx.size, segments: ctx.segments, cover: ctx.cover, scale, counters };
  const u = ctx.u;
  const windDir = vec3(0.83, 0, 0.55);
  const sunDir = uniform(ctx.sunDir);

  const rings: (KeepRing & { N: number; keep: ReturnType<typeof buildKeepPass>; mesh: THREE.Mesh; listed: number })[] = [];
  const caps: number[] = [];
  RINGS.forEach((ring, k) => {
    const cell = ring.cell, radius = ring.radius * scale;
    const inner = k === 0 ? 0 : RINGS[k - 1].radius * scale;
    const S = Math.ceil((Math.ceil((radius * 2) / cell) + 1) / TILES); // cells a side per tile
    const N = S * TILES;
    const spec: KeepRing = { k, cell, radius, inner, nextCell: RINGS[k + 1]?.cell ?? null, S, tiles: TILES, toGround: k === RINGS.length - 1 ? farSpan(k) : null };
    const cap = ringCapacity(spec);
    caps.push(cap);
    const keep = buildKeepPass(keepCtx, spec, cap);

    const vColour = varying(vec3(0), 'vGrassColour'); // the blade's tip colour
    const vBlade = varying(vec2(0), 'vGrassBlade'); // (along 0..1, across -1..1)
    const vLight = varying(vec2(0), 'vGrassLight'); // (sun through the blade, the root's darkening)
    const vClip = varying(vec4(0, 0, 0, 1), 'vGrassClip'), vPrevClip = varying(vec4(0, 0, 0, 1), 'vGrassPrevClip');

    // the blade the keep pass listed (src/grass-keep.ts)
    const list = storage(keep.listAttr, 'uvec4', cap * BLADE).toReadOnly();
    const position = Fn(() => {
      const bv = attribute<'vec2'>('bv', 'vec2');
      const t = bv.x, side = bv.y;
      const b0 = list.element(instanceIndex.mul(BLADE)), b1 = list.element(instanceIndex.mul(BLADE).add(1));
      const base = vec3(uintAsFloat(b0.x), uintAsFloat(b0.y), uintAsFloat(b0.z)).toVar();
      const hw = unpackHalf(b0.w), lean2 = unpackHalf(b1.x), arc = unpackHalf(b1.y), misc = unpackHalf(b1.z);
      const look = unpackUnorm4(b1.w);
      const xz = base.xz;
      const height = hw.x;
      const width = hw.y.mul(float(1).sub(t.pow(2.5))); // parallel, then the tip
      const lean = vec3(lean2.x, 0, lean2.y);
      // seen edge-on, a blade turns up to ~25 degrees towards the viewer (per blade; edge-on it's a thin line)
      const toCam = viewerPos.xz.sub(xz).normalize();
      const across0 = vec2(lean2.y, lean2.x.negate());
      const facing = vec2(toCam.y.negate(), toCam.x);
      const turned = mix(across0, facing.mul(sign(facing.dot(across0))), float(1).sub(abs(toCam.dot(lean2))).mul(0.45)).normalize();
      const across = vec3(turned.x, 0, turned.y);
      // an arc: tilted at the root, bending further along it
      const tilt = arc.x, bendK = arc.y;
      const mid = tilt.add(bendK.mul(t).mul(0.5)), ang = tilt.add(bendK.mul(t));
      const local = across.mul(side.mul(width).mul(0.5)).add(lean.mul(t.mul(height).mul(sin(mid)))).add(vec3(0, t.mul(height).mul(cos(mid)), 0));
      // wind: gusts rolling across the field plus a flutter per blade, bending with the square of t
      const windAt = (time: Float): Vec3 => {
        const roll = sin(time.mul(1.6).sub(xz.x.mul(0.21)).sub(xz.y.mul(0.14))).mul(0.5).add(0.5);
        const flutter = sin(time.mul(5.3).add(misc.x.mul(6.28))).mul(0.25);
        return windDir.mul(t.mul(t).mul(height).mul(u.wind).mul(roll.mul(0.55).add(flutter.mul(0.3)).add(0.1)));
      };
      const world = curve(base.add(local).add(windAt(u.time)));
      const prevWorld = curve(base.add(local).add(windAt(u.prevTime)));
      // the blade's upper face along the arc (more to the sky the further it's bent over), lit like a surface: bent
      // most of the way up, rounded across the width (smooth shading over each blade instead of flat facets)
      const face = vec3(0, 1, 0).mul(sin(ang)).sub(lean.mul(cos(ang)));
      normalLocal.assign(mix(face, vec3(0, 1, 0), 0.6).add(across.mul(side.mul(0.5))).normalize());
      vBlade.assign(vec2(t, side));
      // sun through the blade: the face we see turned away from the sun (less under the canopy: misc.y)
      const seen = face.mul(sign(face.dot(viewerPos.sub(base.add(local)))));
      vLight.assign(vec2(clamp(seen.dot(sunDir).negate(), 0, 1).mul(misc.y), look.w));
      vColour.assign(look.xyz);
      const viewProj = cameraProjectionMatrix.mul(cameraViewMatrix);
      vClip.assign(viewProj.mul(vec4(world, 1)));
      vPrevClip.assign(viewProj.mul(vec4(prevWorld, 1)));
      return world;
    })();

    const mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
    mat.positionNode = position;
    // per pixel: darker at the root, to the tip colour, a pale midrib, darker edges, drying at the very tip, yellow-
    // green where the sun shines through (the old root colour, dark green up to 3/4 of the blade, made every blade
    // darker than the ground it stood on)
    const along = vBlade.x, acrossB = vBlade.y.abs();
    const body = vColour.mul(mix(vLight.y, 1, smoothstep(0, 0.45, along))).mul(mix(0.8, 1, smoothstep(0.2, 0.8, along)))
      .mul(vec3(1.05, 1.15, 0.6).mul(vLight.x.mul(smoothstep(0.1, 0.6, along)).mul(0.9)).add(1));
    const rib = float(1).sub(smoothstep(0.04, 0.16, acrossB)).mul(0.18).mul(smoothstep(0.1, 0.4, along));
    const edge = float(1).sub(acrossB.mul(acrossB).mul(0.3));
    const dryTip = smoothstep(0.85, 1, along).mul(0.35);
    mat.colorNode = mix(body.mul(edge).add(rib.mul(0.12)), vec3(0.45, 0.4, 0.2), dryTip);
    mat.normalNode = normalViewGeometry; // (keep the up-bent normal on both faces: the default flips it on the back)
    mat.receivedShadowNode = ctx.receivedShadow as typeof mat.receivedShadowNode;
    const motion = vClip.xy.div(vClip.w).sub(vPrevClip.xy.div(vPrevClip.w)).mul(vec2(0.5, -0.5));
    mat.mrtNode = mrt({ wind: vec4(motion, 0, 1) });
    const geo = bladeGeometry(ring.segs);
    geo.setIndirect(counters.attr, k * ARGS * 4); // (byte offset: the keep pass counts the blades)
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; // (the keep pass culls)
    mesh.receiveShadow = true;
    mesh.name = `grass-${k}`;
    group.add(mesh);
    rings.push({ ...spec, N, keep, mesh, listed: 0 });
  });
  const { reset, clampCount } = countersPasses(counters, caps);

  /** Lowest and highest terrain vertex over the square [x0, x0 + w] x [z0, z0 + w]. */
  const heightRange = (x0: number, z0: number, w: number): [number, number] => {
    const at = (v: number): number => Math.min(n - 1, Math.max(0, (v + ctx.size / 2) / step));
    let lo = Infinity, hi = -Infinity;
    for (let iz = Math.floor(at(z0)); iz <= Math.ceil(at(z0 + w)); iz++)
      for (let ix = Math.floor(at(x0)); ix <= Math.ceil(at(x0 + w)); ix++) {
        const h = heights[iz * n + ix];
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    return [lo, hi];
  };
  const frustum = new THREE.Frustum(), box = new THREE.Box3(), viewProj = new THREE.Matrix4();

  return {
    group,
    /** Moves each ring's grid to the viewer (whole cells) and picks the tiles to draw. */
    update(camera: THREE.Camera): void {
      shown.value = group.visible ? 1 : 0;
      if (!group.visible) return;
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const c = camera.position;
      for (const r of rings) {
        const ox = Math.floor(c.x / r.cell) - (r.N >> 1), oz = Math.floor(c.z / r.cell) - (r.N >> 1);
        r.keep.origin.value.set(ox, oz);
        r.keep.view.value.copy(camera.matrixWorldInverse);
        const w = r.S * r.cell;
        let listed = 0;
        for (let ty = 0; ty < TILES; ty++)
          for (let tx = 0; tx < TILES; tx++) {
            const x0 = (ox + tx * r.S) * r.cell, z0 = (oz + ty * r.S) * r.cell;
            // every blade is dropped past the radius and inside 80% of the inner ring's (by 3D distance, see `keep`;
            // by the distance along the ground alone, from high up every tile under the camera was tested, all of it
            // dropped: 20% of a phone's GPU time 8 km up, when every tested blade was drawn)
            const [lo, hi] = heightRange(x0, z0, w);
            const near = Math.hypot(Math.max(x0 - c.x, 0, c.x - x0 - w), Math.max(z0 - c.z, 0, c.z - z0 - w), Math.max(0, c.y - hi - 1, lo - c.y));
            if (near >= r.radius) continue;
            const far = Math.hypot(Math.max(c.x - x0, x0 + w - c.x), Math.max(c.z - z0, z0 + w - c.z), Math.max(c.y - lo, hi + 1 - c.y));
            if (far <= r.inner * 0.8) continue;
            box.min.set(x0 - 0.5, lo - 0.3, z0 - 0.5); // (a blade leans and bends up to ~0.3 m off its cell)
            box.max.set(x0 + w + 0.5, hi + 1, z0 + w + 0.5);
            if (frustum.intersectsBox(box)) r.keep.tileValues[listed++].set(tx * r.S, ty * r.S, 0, 0);
          }
        r.listed = listed;
        r.keep.count.value = listed * r.S * r.S;
        r.mesh.visible = listed > 0;
      }
      computeBatch(ctx.renderer, [reset, ...rings.filter((r) => r.listed > 0).map((r): [THREE.ComputeNode, number] => [r.keep.pass, r.listed * r.S * r.S]), clampCount]);
    },
    /** Each ring's blades kept last frame, and its list's size (reads the GPU's counters back). */
    async stats() {
      const a = new Uint32Array(await ctx.renderer.getArrayBufferAsync(counters.attr));
      return rings.map((r, k) => ({ ring: k, cells: r.listed * r.S * r.S, kept: a[k * ARGS + 1], cap: caps[k] }));
    },
  };
}
