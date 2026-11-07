// The impostors' depth prepass (`?imppre=0`: none). Their shader can discard (the alpha test), so the GPU can't reject a pixel
// before shading it unless something nearer is already in the depth buffer, and from above the crowns overlap many deep:
// every layer was lit, shadowed and fogged. The prepass draws the impostors first with their alpha alone (no colour or
// light), then the lit ones only where their depth equals it, writing none: the front one of each pixel, the same image
// (the alpha from the same nodes: ~180 of 1.4M pixels differed on `canopy` / `d1100`, the means alike). The AMD iGPU
// (AGENTS.md's reference low-end PC) at its lowest tier: `slope` 12.8 -> 9.3 ms, `canopy` 14.9 -> 13.2, `amdground` the
// same; the dev GPU at 1080p -0.15..0.5 ms (`slope`, `overview`, `fogline`, `d1100`), the ground views the same.
import * as THREE from 'three/webgpu';
import { PHASE2_LAYER } from './constants.ts';
import type { Vec3, Vec4 } from '../types.ts';

export const IMP_PRE = new URLSearchParams(location.search).get('imppre') !== '0';

/** Adds the prepass to the impostors' `mesh` (a child: shown and hidden with it): `alpha` its colour, `position` its vertex. */
export function impostorPrepass(mesh: THREE.Mesh, alpha: Vec4, position: Vec3): void {
  const mat = mesh.material as THREE.NodeMaterial;
  const pre = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: mat.alphaTest });
  pre.alphaToCoverage = mat.alphaToCoverage;
  pre.colorWrite = false;
  pre.lights = false;
  pre.fog = false;
  pre.colorNode = alpha;
  pre.positionNode = position;
  const preMesh = new THREE.Mesh(mesh.geometry, pre);
  preMesh.frustumCulled = false;
  preMesh.name = `${mesh.name}-pre`;
  preMesh.layers.set(PHASE2_LAYER);
  preMesh.renderOrder = -1; // (before every other phase 2 draw)
  mesh.add(preMesh);
  mat.depthFunc = THREE.EqualDepth;
  mat.depthWrite = false;
}
