// Grass: blades drawn around the viewer in three rings, each an instanced mesh over a grid of world-space cells that
// follows the camera (snapped to whole cells, so a blade stays where it is while you fly). Each ring has coarser
// cells and wider blades than the one inside it and they cross-fade by distance, so the covered fraction of the
// ground stays even; the outer ring thins out into the ground's own colour. Everything is in the vertex shader:
// position and size from a hash of the cell, height from the terrain's own vertex heights (same triangles as the
// terrain mesh, so blades stand exactly on it), density from the canopy cover, the slope and patch noise, wind.
import * as THREE from 'three/webgpu';
import {
  Fn, instanceIndex, attribute, uniform, float, vec2, vec3, vec4, int, ivec2, uint, hash, sin, cos, mix, clamp,
  smoothstep, textureLoad, texture, varying, normalLocal, mx_noise_float, cameraProjectionMatrix, cameraViewMatrix,
  mrt, select, sqrt, normalViewGeometry,
} from 'three/tsl';
import { curve, viewerPos } from './planet.ts';
import { roadDistanceNode } from './road.ts';
import type { Float, Vec2, Vec3 } from './types.ts';
import type { ForestUniforms } from './nanite/types.ts';

const params = new URLSearchParams(location.search);
const SEGS = 4; // segments per blade: 2 * SEGS + 1 vertices, 2 * SEGS - 1 triangles
/** A blade grows in over this share of its keep chance (`?grassgrow=`, 0 = pops): popping in whole, walking forward
 * showed grass appearing ahead (the user). */
const GROW = Number(params.get('grassgrow') ?? 0.3);

/** The rings: cell size (m) and outer radius (m); each fades in over the last 20% of the ring inside it. */
const RINGS = [
  { cell: 0.09, radius: 16 },
  { cell: 0.2, radius: 40 },
  { cell: 0.45, radius: 90 },
];

export interface GrassContext {
  terrain: THREE.Mesh; // the detailed terrain square (its vertex heights)
  size: number; // its side (m)
  segments: number;
  cover: { texture: THREE.Texture; extent: number }; // canopy cover (forestDensity)
  u: ForestUniforms; // time, prevTime, wind
  receivedShadow: unknown; // the ground's receivedShadowNode (map shadow fading into the far-field shade)
}

/** One blade: (t along it 0..1, side -1..1). Triangle strip as indexed triangles. */
function bladeGeometry(instances: number): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
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
  geo.instanceCount = instances;
  return geo;
}

export function createGrass(ctx: GrassContext) {
  const scale = Number(params.get('grass') ?? (matchMedia('(pointer: coarse)').matches ? 0.5 : 1)); // ring radii
  const group = new THREE.Group();
  group.name = 'grass';
  if (!(scale > 0)) return { group, update() {} };

  // terrain heights as a float texture: the terrain mesh's vertices, read back exactly
  const n = ctx.segments + 1;
  const pos = ctx.terrain.geometry.attributes.position;
  const heights = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) heights[i] = pos.getY(i);
  const heightTex = new THREE.DataTexture(heights, n, n, THREE.RedFormat, THREE.FloatType);
  heightTex.needsUpdate = true;
  const step = ctx.size / ctx.segments;

  /** Ground height and slope (|gradient|) at world xz: the terrain mesh's triangles (PlaneGeometry's split). */
  const ground = (p: Vec2): { y: Float; slope: Float } => {
    const g = p.add(ctx.size / 2).div(step);
    const i = clamp(g.floor(), 0, n - 2), f = g.sub(i);
    const at = (dx: number, dz: number): Float => textureLoad(heightTex, ivec2(int(i.x).add(dx), int(i.y).add(dz))).x;
    const a = at(0, 0), b = at(0, 1), c = at(1, 1), d = at(1, 0);
    const upper = f.x.add(f.y).greaterThan(1);
    // (a, b, d) below the b-d diagonal, (b, c, d) above it
    const y = select(upper, c.add(b.sub(c).mul(float(1).sub(f.x))).add(d.sub(c).mul(float(1).sub(f.y))), a.add(d.sub(a).mul(f.x)).add(b.sub(a).mul(f.y)));
    const gx = select(upper, c.sub(b), d.sub(a)), gz = select(upper, c.sub(d), b.sub(a));
    return { y, slope: sqrt(gx.mul(gx).add(gz.mul(gz))).div(step) };
  };

  const coverAt = (p: Vec2) => texture(ctx.cover.texture, p.div(ctx.cover.extent * 2).add(0.5)); // (r cover, g fallen leaves)
  const u = ctx.u;
  const windDir = vec3(0.83, 0, 0.55);

  RINGS.forEach((ring, k) => {
    const cell = ring.cell, radius = ring.radius * scale;
    const inner = k === 0 ? 0 : RINGS[k - 1].radius * scale;
    const N = Math.ceil((radius * 2) / cell) + 1;
    const origin = uniform(new THREE.Vector2()); // the grid's corner cell (whole cells)

    const vColour = varying(vec3(0), 'vGrassColour'); // the blade's tip colour
    const vBlade = varying(vec2(0), 'vGrassBlade'); // (along 0..1, across -1..1)
    const vClip = varying(vec4(0, 0, 0, 1), 'vGrassClip'), vPrevClip = varying(vec4(0, 0, 0, 1), 'vGrassPrevClip');

    const position = Fn(() => {
      const bv = attribute<'vec2'>('bv', 'vec2');
      const t = bv.x, side = bv.y;
      const ci = vec2(float(instanceIndex.mod(uint(N))), float(instanceIndex.div(uint(N)))).add(origin);
      const seed = uint(int(ci.x).add(1 << 20)).mul(73856093).bitXor(uint(int(ci.y).add(1 << 20)).mul(19349663)).add(k * 7919);
      const r = (j: number): Float => hash(seed.add(j * 101));
      const xz = ci.add(vec2(r(0), r(1))).mul(cell);
      const g = ground(xz);
      const d = vec3(xz.x, g.y, xz.y).sub(viewerPos).length(); // (3D: flying up, the grass thins out evenly)
      // ring cross-fade: fade in over the inner ring's last 20%, out over this ring's last 20% (the outermost to 0)
      const fadeIn = k === 0 ? float(1) : smoothstep(inner * 0.8, inner, d);
      const fadeOut = float(1).sub(smoothstep(radius * 0.8, radius, d));
      const patch = mx_noise_float(xz.mul(0.045)).mul(0.5).add(0.5);
      // (thinner under the canopy, and where the fallen leaves lie thick: under the red trees most)
      const cv = coverAt(xz);
      // (none on the road and the plaza: src/road.ts)
      const density = smoothstep(0.1, 0.9, roadDistanceNode(xz)).mul(float(1).sub(cv.r.mul(0.6))).mul(float(1).sub(cv.g.mul(1.4).min(1).mul(cv.r).mul(0.85))).mul(float(1).sub(smoothstep(0.45, 0.8, g.slope))).mul(smoothstep(0.05, 0.45, patch));
      // morph towards the next ring across this one: fewer, wider blades, so where they hand over (the last 20%) both
      // look alike (a straight switch was a line in the grass that moved along with the camera: the user)
      const next = RINGS[k + 1];
      const m = next ? mix(1, next.cell / ring.cell, smoothstep(k === 0 ? 3 : inner, radius * 0.8, d)) : float(1);
      const keep = fadeIn.mul(fadeOut).mul(density).div(m.mul(m));
      const alive = r(2).lessThan(keep);
      // how far it's grown: from nothing where it's just kept to full size a share GROW of the chance further in, so
      // the blades that come and go with the distance rise out of the ground and sink back instead of popping
      const grown = GROW > 0 ? clamp(keep.sub(r(2)).div(keep.mul(GROW).max(1e-4)), 0, 1) : float(1);

      // the blade: height, width (wider in the outer rings: same covered fraction), facing, lean
      const lush = smoothstep(0.3, 0.8, patch);
      const height = mix(0.22, 0.6, r(3)).mul(mix(0.6, 1.15, lush)).mul(grown);
      const width = float(cell * 0.6).mul(m).mul(sqrt(grown)).mul(float(1).sub(t.mul(t))); // tapering to the tip
      const yaw = r(4).mul(6.2832);
      const across = vec3(cos(yaw), 0, sin(yaw)), lean = vec3(sin(yaw).negate(), 0, cos(yaw));
      const bend = t.mul(t).mul(height).mul(mix(0.1, 0.45, r(5)));
      const base = vec3(xz.x, g.y.sub(0.04), xz.y);
      const local = across.mul(side.mul(width).mul(0.5)).add(lean.mul(bend)).add(vec3(0, t.mul(height), 0));
      // wind: gusts rolling across the field plus a flutter per blade, bending with the square of t
      const windAt = (time: Float): Vec3 => {
        const roll = sin(time.mul(1.6).sub(xz.x.mul(0.21)).sub(xz.y.mul(0.14))).mul(0.5).add(0.5);
        const flutter = sin(time.mul(5.3).add(r(6).mul(6.28))).mul(0.25);
        return windDir.mul(t.mul(t).mul(height).mul(u.wind).mul(roll.mul(0.55).add(flutter.mul(0.3)).add(0.1)));
      };
      const world = curve(base.add(local).add(windAt(u.time)));
      const prevWorld = curve(base.add(local).add(windAt(u.prevTime)));
      // soft normal: the blade's face bent most of the way up (grass lit like a surface, not like flat cards)
      // rounded across the width (smooth shading over each blade instead of flat facets)
      normalLocal.assign(mix(lean, vec3(0, 1, 0), 0.75).add(across.mul(side.mul(0.55))).normalize());
      vBlade.assign(vec2(t, side));
      // colour: dark at the root, lighter and a little yellow at the tip, patches of drier grass
      const dry = smoothstep(0.55, 0.9, mx_noise_float(xz.mul(0.11).add(17)).mul(0.5).add(0.5)).mul(0.6).add(r(7).mul(0.25));
      const tip = mix(vec3(0.36, 0.5, 0.13), vec3(0.58, 0.54, 0.25), dry);
      vColour.assign(tip.mul(mix(0.85, 1.1, r(8))));
      const viewProj = cameraProjectionMatrix.mul(cameraViewMatrix);
      vClip.assign(viewProj.mul(vec4(world, 1)));
      vPrevClip.assign(viewProj.mul(vec4(prevWorld, 1)));
      // dropped blades (and those behind the camera: decided per blade, at the root) collapse onto their root
      const root = curve(base);
      const behind = cameraViewMatrix.mul(vec4(root, 1)).z.greaterThan(1);
      return select(alive.and(behind.not()), world, root);
    })();

    const mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
    mat.positionNode = position;
    // per pixel: dark root to the tip colour, a pale midrib, darker edges, drying at the very tip
    const along = vBlade.x, acrossB = vBlade.y.abs();
    const body = mix(vec3(0.12, 0.17, 0.05), vColour, smoothstep(0, 0.75, along));
    const rib = float(1).sub(smoothstep(0.04, 0.16, acrossB)).mul(0.18).mul(smoothstep(0.1, 0.4, along));
    const edge = float(1).sub(acrossB.mul(acrossB).mul(0.3));
    const dryTip = smoothstep(0.85, 1, along).mul(0.35);
    mat.colorNode = mix(body.mul(edge).add(rib.mul(0.12)), vec3(0.45, 0.4, 0.2), dryTip);
    mat.normalNode = normalViewGeometry; // (keep the up-bent normal on both faces: the default flips it on the back)
    mat.receivedShadowNode = ctx.receivedShadow as typeof mat.receivedShadowNode;
    const motion = vClip.xy.div(vClip.w).sub(vPrevClip.xy.div(vPrevClip.w)).mul(vec2(0.5, -0.5));
    mat.mrtNode = mrt({ wind: vec4(motion, 0, 1) });
    const mesh = new THREE.Mesh(bladeGeometry(N * N), mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.name = `grass-${k}`;
    mesh.userData.ring = { origin, cell, N };
    group.add(mesh);
  });

  return {
    group,
    /** Moves each ring's grid to the viewer (whole cells). */
    update(camera: THREE.Camera): void {
      for (const m of group.children) {
        const { origin, cell, N } = m.userData.ring as { origin: { value: THREE.Vector2 }; cell: number; N: number };
        origin.value.set(Math.floor(camera.position.x / cell) - (N >> 1), Math.floor(camera.position.z / cell) - (N >> 1));
      }
    },
  };
}
