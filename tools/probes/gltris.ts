// The WebGL mode's forest by mesh group (run with --query=webgl=1): triangles and instances drawn per kind (bark,
// leaves, shadow casters, statues, impostors) and near level, from the meshes' index counts x instance counts.
import type { Demo } from '../../src/harness-api.ts';
import type * as THREE from 'three/webgpu';

async (demo: Demo) => {
  await demo.renderOnce();
  const out: Record<string, { tris: number; instances: number; meshes: number }> = {};
  demo.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || !/^webgl-|^grass/.test(m.name)) return;
    const g = m.geometry as THREE.InstancedBufferGeometry;
    const n = g.instanceCount ?? 1;
    if (!(n > 0)) return;
    const tris = ((g.index?.count ?? g.attributes.position.count) / 3) * n;
    const k = m.name.replace(/-\d+-(\d+)$/, '-L$1').replace(/^webgl-impostors$/, 'impostors');
    const e = (out[k] ??= { tris: 0, instances: 0, meshes: 0 });
    e.tris += tris;
    e.instances += n;
    e.meshes++;
  });
  const total = Object.values(out).reduce((s, e) => s + e.tris, 0);
  return { total, ...out };
}
