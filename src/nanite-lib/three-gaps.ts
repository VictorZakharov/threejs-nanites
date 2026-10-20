// Where @types/three (0.186) lags three.js's runtime API: the casts live here, each with what it papers over, so
// they're easy to drop when the typings catch up. Nothing here changes behaviour.
import type * as THREE from 'three/webgpu';
import { floatBitsToUint, uintBitsToFloat, packHalf2x16, packUnorm4x8, unpackHalf2x16, unpackUnorm4x8 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Float, Uint, Vec2, Vec4 } from './types.ts';

/** MeshLambertNodeMaterial has an emissive input (it's lit like the standard material), not in the typings. */
export function setEmissive(mat: THREE.MeshLambertNodeMaterial, node: Node): void {
  (mat as THREE.MeshLambertNodeMaterial & { emissiveNode: Node | null }).emissiveNode = node;
}

/** receivedShadowNode is called with the shadow factor (`Fn(([shadow]) => ...)`); typed as taking nothing. */
export const asReceivedShadow = (fn: unknown): (() => Node) => fn as () => Node;

/** floatBitsToUint returns an untyped bitcast node. */
export const floatBits = (f: Parameters<typeof floatBitsToUint>[0], impl: typeof floatBitsToUint): Uint => impl(f) as unknown as Uint;

/** The renderer's WebGPU backend: its device and whether timestamp queries are on (typed as the generic Backend). */
export const gpuBackend = (r: THREE.WebGPURenderer) =>
  r.backend as unknown as { device: GPUDevice; trackTimestamp: boolean; isWebGPUBackend?: boolean };

/**
 * Several compute dispatches in one compute pass, in order (WebGPU makes each one's writes visible to the next).
 * `[node, size]`: a count of threads, or an indirect dispatch buffer; none = the node's own count. The renderer reads a
 * node's `dispatchSize` (typed as numbers only; an indirect buffer works too). Each `renderer.compute()` was a pass of its own
 * with its own timestamp queries: ~36 a frame, most of them a few threads (counter resets, clamps).
 */
export function computeBatch(r: THREE.WebGPURenderer, list: (THREE.ComputeNode | [THREE.ComputeNode, number | THREE.IndirectStorageBufferAttribute])[]): void {
  const nodes = list.map((e) => {
    const [node, size] = Array.isArray(e) ? e : [e, null];
    (node as unknown as { dispatchSize: unknown }).dispatchSize = size;
    return node;
  });
  r.compute(nodes);
}

/** The pack/unpack and uint-to-float bitcast nodes are typed as untyped nodes (their WGSL types: u32, vec2f, vec4f, f32). */
export const packHalf = (v: Vec2): Uint => packHalf2x16(v) as unknown as Uint;
export const packUnorm4 = (v: Vec4): Uint => packUnorm4x8(v) as unknown as Uint;
export const unpackHalf = (u: Uint): Vec2 => unpackHalf2x16(u) as unknown as Vec2;
export const unpackUnorm4 = (u: Uint): Vec4 => unpackUnorm4x8(u) as unknown as Vec4;
export const uintAsFloat = (u: Uint): Float => uintBitsToFloat(u) as unknown as Float;
export const floatAsUint = (f: Float): Uint => floatBitsToUint(f) as unknown as Uint;
