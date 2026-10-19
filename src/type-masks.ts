// Debug 4's flat type colours (the harness's type masks, tools/harness/typematch.ts) drawn so a tree's pixel is its
// id: no fog (it paled them past classifying), no tone mapping (ACES moved the hues: pines read as aspens), no ground
// or grass (sunlit ground passed for Oak Medium or Ash, more of it between see-through impostors) and no god rays
// (the open sky left feeds them). The switches go back to what they were when debug 4 ends.
import * as THREE from 'three/webgpu';
import type { UniformNode } from 'three/webgpu';

interface Switches {
  renderer: THREE.WebGPURenderer;
  hide: THREE.Object3D[]; // (the terrain, the grass)
  rays: { enabled: boolean };
  fogNear: UniformNode<'float', number>;
  fogFar: UniformNode<'float', number>;
}

/** Per frame, after the fog is set: `on` while debug 4 is. */
export function typeMaskMode({ renderer, hide, rays, fogNear, fogFar }: Switches): (on: boolean) => void {
  let saved: { visible: boolean[]; rays: boolean; tone: THREE.ToneMapping } | null = null;
  return (on) => {
    if (on) fogNear.value = fogFar.value - 1;
    if (on === Boolean(saved)) return;
    if (on) {
      saved = { visible: hide.map((o) => o.visible), rays: rays.enabled, tone: renderer.toneMapping };
      for (const o of hide) o.visible = false;
      rays.enabled = false;
      renderer.toneMapping = THREE.NoToneMapping;
    } else if (saved) {
      hide.forEach((o, k) => (o.visible = saved!.visible[k]));
      rays.enabled = saved.rays;
      renderer.toneMapping = saved.tone;
      saved = null;
    }
  };
}
