// Where @types/three (0.186) lags three.js's runtime API: the casts live here, each with what it papers over, so
// they're easy to drop when the typings catch up. Nothing here changes behaviour.
import type * as THREE from 'three/webgpu';
import type { floatBitsToUint } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Uint } from './types.ts';

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
