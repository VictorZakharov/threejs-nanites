// Types shared by the renderer's modules (src/nanite-lib/gpu/), and its inputs.
import type * as THREE from 'three/webgpu';
import type { ComputeNode, StorageBufferNode, UniformArrayNode, UniformNode } from 'three/webgpu';
import type { Bool, Float, Uint, Vec2, Vec3 } from '../types.ts';
import type { makeCounters } from './constants.ts';
import type { DagResult, DagStats, BarkSource, LeafSource } from '../dag/types.ts';

/** A uniform holding a JS value. */
export type U<T extends string, V> = UniformNode<T, V>;

/** The renderer's uniforms (NaniteRenderer.u), plus the ones the software rasterizer adds. */
export interface NaniteUniforms {
  camPos: U<'vec3', THREE.Vector3>;
  projScale: U<'float', number>;
  tau: U<'float', number>;
  maxDist: U<'float', number>;
  impostorPx: U<'float', number>;
  firstModel: U<'uint', number>;
  time: U<'float', number>;
  prevTime: U<'float', number>;
  debug: U<'uint', number>;
  occlusion: U<'uint', number>;
  sunDir: U<'vec3', THREE.Vector3>;
  castLen: U<'float', number>;
  sw?: U<'uint', number>;
  swArea?: U<'float', number>;
}

/**
 * The texture arrays of the two kinds of geometry, solid triangles ("bark") and alpha-tested cards ("leaf"), and
 * which layer each type samples. The leaf array's userData holds its mip `levels` and coverage-preserving
 * `alphaScales` (coverageScales in alpha.ts, per layer and level).
 */
export interface NaniteTextures {
  bark: THREE.DataArrayTexture;
  leaf: THREE.DataArrayTexture;
  barkLayerOf: (type: Uint) => Float;
  leafLayerOf: (type: Uint) => Float;
  alphaToCoverage: boolean; // (the scene target has MSAA)
  leafDither: boolean; // (it hasn't, under TAA: leaves by coverage against a moving dither, see draw.ts)
}

/** A view's counters buffer (see makeCounters). */
export type Counters = ReturnType<typeof makeCounters>;

/** A tree type's row of the type table: (first cluster, cluster count, bounding radius, height). */
export type TypeInfo = ReturnType<UniformArrayNode<'vec4'>['element']>;

/** One cull -> draw chain of a view (see _buildSet). */
export interface CullSet {
  base: number; // its slice of the view's counters
  itemsAttr: THREE.StorageBufferAttribute;
  dispatchAttr: THREE.IndirectStorageBufferAttribute;
  listAttr: THREE.StorageBufferAttribute; // the bark list, then the leaf list
  ctr: Counters;
  ran?: boolean;
  stat(i: number): ReturnType<Counters['atomic']['element']>;
  append(inst: Uint, c: Uint, cw: Vec3, rad: Float): void;
  emit(i: Uint, ti: TypeInfo, s: Float, dCam: Float, r: Float): void;
  reset: ComputeNode;
  clampDispatch: ComputeNode;
  clusters: ComputeNode;
  clampDraw: ComputeNode;
}

/** The main view's occlusion retests: lists, counts, and the passes that test them again (see _buildRetest). */
export interface Retest {
  treesAttr: THREE.StorageBufferAttribute;
  clustersAttr: THREE.StorageBufferAttribute;
  treeDispatch: THREE.IndirectStorageBufferAttribute;
  clusterDispatch: THREE.IndirectStorageBufferAttribute;
  tree(i: Uint): void;
  cluster(inst: Uint, c: Uint): void;
  count(i: number): Uint;
  treesRO: StorageBufferNode<'uint'>;
  clustersRO: StorageBufferNode<'uvec2'>;
  reset: ComputeNode;
  args: ComputeNode;
  treesPass?: ComputeNode;
  clustersPass?: ComputeNode;
}

/** What a view's sets are built from (see _buildView). */
export interface ViewBase {
  name: string;
  planes: UniformArrayNode<'vec4'>;
  planeValues: THREE.Vector4[]; // (the uniform array's values: set per frame)
  tauMul: U<'float', number>;
  lodPos: U<'vec3', THREE.Vector3>;
  lodShift: THREE.Vector3;
  impListAttr: THREE.StorageBufferAttribute; // the trees drawn as impostors this frame (their count: IMP_ARGS)
  impRetest: U<'uint', number>; // (main view) 1: phase 2 lists the impostors that pass the occlusion test
  ctr: Counters;
  // the chunks it can see this frame: (first instance, count) each (a uniform array: the main view's instance pass
  // already binds 8 storage buffers), see chunks.ts
  chunkValues: THREE.Vector4[];
  chunkList: UniformArrayNode<'vec4'>;
  sphereVisible(c: Vec3, r: Float): Bool;
  retest: Retest | null;
}

/** The camera's or the sun's culling: frustum, LOD origin, impostor list, its sets and the instance pass. */
export interface View extends ViewBase {
  sets: CullSet[];
  instances: ComputeNode;
  impReset: ComputeNode;
  ran?: boolean;
}

/** A cluster vertex as drawn (see _vertex): curved world position with this and last frame's motion. */
export interface ClusterVertex {
  world: Vec3;
  prevWorld: Vec3;
  normal: Vec3;
  uv: Vec2;
  type: Uint;
}

/**
 * Shadows and fog for the materials that compute their own world position (the software rasterizer's and the splats'
 * resolves), so they match the application's materials: `fadeShadow(pos)` is the receivedShadowNode function.
 */
export interface Shading {
  fadeShadow(pos: Vec3): unknown;
  fog(pos: Vec3, viewZ: Float): { color: Vec3; factor: Float };
}

/** One mesh type: its cluster DAG (dag/build.ts or a model file), its bounds round its vertical axis and its sources. */
export interface NaniteType extends DagResult {
  name: string;
  radius: number;
  height: number;
  /** Never drawn as an impostor (with the instances from `firstModel` on: the renderer's instances are in type order). */
  noImpostor?: boolean;
  /** The full-detail source meshes (the impostor bake's frame, and its full-detail bake). */
  src: { bark: BarkSource; leaves: LeafSource };
  /**
   * Still downloading (its arrays empty, its radius a bound): the sizes reserved for it in the renderer's buffers, and
   * the type once it's in (NaniteRenderer.fillType).
   */
  later?: { verts: number; indices: number; clusters: number; tree: Promise<NaniteType> };
}

/**
 * The instances, in two arrays of 4 floats each: a = (x, y, z, scale), b = (cos, sin, type, user) (a rotation round
 * the vertical axis; `user` is the application's, read by its hooks). From `firstModel` on they're never impostors.
 */
export interface NaniteInstances {
  a: Float32Array;
  b: Float32Array;
  firstModel?: number;
}

/** Per-frame counters read back for the HUD and the harness (NaniteRenderer.readStats). */
export interface NaniteStats {
  barkClusters: number;
  leafClusters: number;
  barkTris: number;
  leafTris: number;
  instances: number;
  items: number;
  impostors: number;
  occluded: number;
  occludedImpostors: number;
  phase2: number;
  splats?: number;
  swClusters?: number;
  swTris?: number;
}
