// Types shared by the forest renderer's modules (src/nanite/).
import type * as THREE from 'three/webgpu';
import type { ComputeNode, StorageBufferNode, UniformArrayNode, UniformNode } from 'three/webgpu';
import type { Bool, Float, Uint, Vec2, Vec3 } from '../types.ts';
import type { makeCounters } from './constants.ts';
import type { createLighting } from '../lighting.ts';

/** A uniform holding a JS value. */
export type U<T extends string, V> = UniformNode<T, V>;

/** The forest's uniforms (NaniteForest.u), plus the ones the software rasterizer adds. */
export interface ForestUniforms {
  camPos: U<'vec3', THREE.Vector3>;
  projScale: U<'float', number>;
  tau: U<'float', number>;
  maxDist: U<'float', number>;
  impostorPx: U<'float', number>;
  firstModel: U<'uint', number>;
  time: U<'float', number>;
  prevTime: U<'float', number>;
  wind: U<'float', number>;
  debug: U<'uint', number>;
  occlusion: U<'uint', number>;
  sunDir: U<'vec3', THREE.Vector3>;
  sw?: U<'uint', number>;
  swArea?: U<'float', number>;
}

/** The bark and leaf texture arrays, and which layer each tree type samples (src/main.ts). */
export interface ForestTextures {
  bark: THREE.DataArrayTexture;
  leaf: THREE.DataArrayTexture;
  barkLayerOf: (type: Uint) => Float;
  leafLayerOf: (type: Uint) => Float;
  alphaToCoverage: boolean;
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

/** A cluster vertex as drawn (see _vertex): curved world position with this and last frame's wind. */
export interface ClusterVertex {
  world: Vec3;
  prevWorld: Vec3;
  normal: Vec3;
  uv: Vec2;
  type: Uint;
}

/** Shadows and fog for materials that compute their own world position (src/main.ts, from lighting.ts). */
export interface Shading {
  fadeShadow(pos: Vec3): ReturnType<ReturnType<typeof createLighting>['makeFadeShadow']>;
  fog(pos: Vec3, viewZ: Float): { color: Vec3; factor: Float };
}

/** Per-frame counters read back for the HUD and the harness (NaniteForest.readStats). */
export interface ForestStats {
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
  swClusters?: number;
  swTris?: number;
}
