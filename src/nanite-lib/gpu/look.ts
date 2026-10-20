// What an application's meshes add to the renderer's shaders: the hooks (TSL functions) the renderer calls where its
// own look comes in. Every one has a default (defaultLook: no curvature, no motion, the textures' own colours), so a
// plain scene passes nothing; the demo's forest passes its planet curve, wind, tints and autumn (src/forest/look.ts).
//
// Hooks get nodes and may add uniforms and textures, never storage buffers: the renderer's shaders already bind up to
// WebGPU's guaranteed 8 (see the merged buffers in buffers.ts). Per-instance data of the application's own is the
// instance's 4th `b` float (b.w; the forest's wind phase and autumn level), which the hooks read.
import * as THREE from 'three/webgpu';
import { float } from 'three/tsl';
import type { Bool, Float, Uint, Vec3, Vec4 } from '../types.ts';

/** A cluster vertex as the motion hook sees it (see NaniteLook.motion). */
export interface MotionInput {
  /** The vertex in its mesh (unrotated, unscaled) and the mesh's height (local units). */
  local: Vec3;
  height: Float;
  /** The instance's a = (x, y, z, scale) and b = (cos, sin, type, user). */
  a: Vec4;
  b: Vec4;
  type: Uint;
  /** A card (alpha-tested quad) vertex: true / false, or a bool node when it's only known per cluster. */
  card: boolean | Bool;
}

export interface NaniteLook {
  /**
   * A world-space transform after instancing (the demo's planet: points drop by d^2 / 2R from the viewer), applied to
   * everything drawn and culled alike; `radius` is the R the CPU's chunk test drops boxes by (Infinity: none) and
   * `viewer` whom from (a vector updated per frame).
   */
  curve: (p: Vec3) => Vec3;
  curveRadius: number;
  viewer: THREE.Vector3;
  /**
   * Per-vertex motion (the forest's wind): for a vertex, a function of time giving its offset in world units (called
   * with this and last frame's time: the motion vectors). None: still.
   */
  motion?: (v: MotionInput) => (time: Float) => Vec3;
  /**
   * The scene's MRT output (by name) that the clusters write their screen motion to (this minus last frame's clip
   * position, uv units, y down; the demo's TAA subtracts it from its camera reprojection): none, not written.
   */
  motionOutput?: string;
  /** How far `motion` can move a part whose top is `top` (local units) of a mesh `height` tall at scale `s` (the culling spheres grow by it). */
  motionMargin?: (height: Float, top: Float, s: Float, type: Float) => Float;
  /** A per-instance brightness factor (the cards' and impostors' colour hooks get it). */
  tint: (inst: Uint) => Float;
  /** A per-instance value the card colour hook gets (interpolated from the vertices; the forest's autumn level). */
  cardValue: (inst: Uint, b: Vec4) => Float;
  /** The same for the impostors' colour hook. */
  impostorValue: (inst: Uint, b: Vec4, type: Uint) => Float;
  /** Solid triangles' colour before lighting, from the texture's. */
  solidColour: (rgb: Vec3) => Vec3;
  /** Cards' colour before lighting: the texture's, its array layer, the instance's tint and cardValue. */
  cardColour: (rgb: Vec3, layer: Float, tint: Float, value: Float) => Vec3;
  /** An impostor's colour before lighting: the baked albedo, its type's colour gain, the tint and impostorValue. */
  impostorColour: (albedo: Vec3, gain: Vec3, tint: Float, value: Float) => Vec3;
  /** The cards' colour baked into the impostor atlas (layer: the cards' texture layer; no per-instance tint). */
  bakeCardColour: (rgb: Vec3, layer: number) => Vec3;
}

/** No curvature, no motion, the textures' own colours. */
export function defaultLook(): NaniteLook {
  return {
    curve: (p) => p,
    curveRadius: Infinity,
    viewer: new THREE.Vector3(),
    tint: () => float(1),
    cardValue: () => float(0),
    impostorValue: () => float(0),
    solidColour: (rgb) => rgb,
    cardColour: (rgb) => rgb,
    impostorColour: (albedo, gain, tint) => albedo.mul(gain).mul(tint),
    bakeCardColour: (rgb) => rgb,
  };
}
