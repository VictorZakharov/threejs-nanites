// The statues in the WebGL mode (src/webgl/): the model (Lucy, BuiltTree.later: drawn once she's downloaded and
// decoded) at a few fixed cuts of her cluster DAG, each statue at the cut its size on screen calls for (picked on the
// CPU every frame: there are a dozen), with the forest's bark material (her stone layer, no wind). Never impostors,
// as on WebGPU.
import * as THREE from 'three/webgpu';
import { dagCut } from '../nanite-lib/index.ts';
import type { BuiltTree } from '../trees.ts';
import type { TreeInstances } from '../placement.ts';
import { setLevel } from './debug.ts';

/** The cuts: her height on screen (px) each is made for, finest first (a statue under the next one's uses the next). */
const PX = [900, 250, 70];

export function createWebGLStatues(model: BuiltTree, type: number, inst: TreeInstances, material: THREE.Material) {
  const group = new THREE.Group();
  group.name = 'webgl-statues';
  const first = inst.a.length / 4 - inst.statues;
  const statues: number[] = [];
  for (let i = first; i < inst.a.length / 4; i++) if (Math.floor(inst.b[i * 4 + 2]) === type) statues.push(i);
  const n = statues.length;
  let shared: Record<string, THREE.BufferAttribute> | null = null; // (every cut indexes the same vertices)
  const levels = PX.map((px, k) => {
    const { bark } = dagCut(model, model.height / px);
    shared ??= { position: new THREE.BufferAttribute(bark.pos, 3), normal: new THREE.BufferAttribute(bark.nrm, 3), uv: new THREE.BufferAttribute(bark.uv, 2) };
    const g = new THREE.InstancedBufferGeometry();
    for (const [k, a] of Object.entries(shared)) g.setAttribute(k, a);
    g.setIndex(new THREE.BufferAttribute(bark.idx, 1));
    const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const b = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', a);
    g.setAttribute('iB', b);
    g.instanceCount = 0;
    const mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.layers.enable(1); // (the shadow camera's layer: lighting.ts)
    mesh.name = `webgl-statue-${px}`;
    setLevel(mesh, k, PX.length);
    group.add(mesh);
    return { g, a, b, tris: bark.idx.length / 3 };
  });
  const sphere = new THREE.Sphere(), frustum = new THREE.Frustum(), m4 = new THREE.Matrix4();
  let drawn = 0;
  return {
    group,
    /** Per frame: each statue in view (or casting into it: within 60 m) at the cut its height on screen calls for. */
    update(camera: THREE.PerspectiveCamera, heightPx: number): void {
      const projScale = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      frustum.setFromProjectionMatrix(m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      for (const L of levels) L.g.instanceCount = 0;
      drawn = 0;
      for (const i of statues) {
        const A = inst.a.subarray(i * 4, i * 4 + 4), B = inst.b.subarray(i * 4, i * 4 + 4);
        const h = model.height * A[3];
        sphere.center.set(A[0], A[1] + h / 2, A[2]);
        sphere.radius = h;
        const d = Math.max(0.3, camera.position.distanceTo(sphere.center) - h / 2);
        if (d > 60 && !frustum.intersectsSphere(sphere)) continue;
        const px = (h * projScale) / d;
        const k = Math.max(0, PX.findLastIndex((p) => p >= px));
        const L = levels[k], j = L.g.instanceCount++;
        (L.a.array as Float32Array).set(A, j * 4);
        (L.b.array as Float32Array).set(B, j * 4);
        drawn += L.tris;
      }
      for (const L of levels) {
        L.a.clearUpdateRanges(); L.b.clearUpdateRanges();
        L.a.addUpdateRange(0, L.g.instanceCount * 4); L.b.addUpdateRange(0, L.g.instanceCount * 4);
        L.a.needsUpdate = L.b.needsUpdate = true;
      }
    },
    /** Triangles drawn last frame (the camera's view). */
    tris: () => drawn,
    count: n,
  };
}
