// What a part of the scene costs on the GPU, in one page: `?cost=` names objects of the scene (default `grass`), or
// `taa` / `rays` (the demo's TAA and god rays: their `enabled`), each switched off and on in alternating blocks of
// `?costframes=` (40) frames, 6 of each, the median GPU ms of each state (render + compute timer queries; the WebGL
// mode's too). Back-to-back runs of the same build swung ~2x on the dev GPU (WebGL ground 7 or 13 ms), so separate
// harness variants can't measure a few ms: alternating blocks in one page can. `name@other` measures a material
// instead: the mesh `name` with its own material ("on") against `other`'s ("off"), the same geometry and depth
// (`terrain@terrain-high`: the forest floor's shader over the plain ground's; the terrain's visibility is set every
// frame by its altitude, so it can't be switched off).
import type { Demo } from '../../src/harness-api.ts';
import type * as THREE from 'three/webgpu';

async (demo: Demo) => {
  const q = new URLSearchParams(location.search);
  const names = (q.get('cost') ?? 'grass').split(',');
  const frames = Number(q.get('costframes') ?? 40);
  const r = demo.renderer;
  const gpu = async (): Promise<number> => ((await r.resolveTimestampsAsync('render')) ?? 0) + ((demo.webgl ? 0 : await r.resolveTimestampsAsync('compute')) ?? 0);
  const median = (a: number[]): number => +[...a].sort((x, y) => x - y)[a.length >> 1].toFixed(2);
  const out: Record<string, unknown> = {};
  for (const name of names) {
    let toggle: { get visible(): boolean; set visible(v: boolean) } | undefined;
    const [own, other] = name.split('@');
    if (other !== undefined) {
      const mesh = demo.scene.getObjectByName(own) as THREE.Mesh | undefined, alt = demo.scene.getObjectByName(other) as THREE.Mesh | undefined;
      if (mesh && alt) {
        const mine = mesh.material;
        toggle = { get visible() { return mesh.material === mine; }, set visible(v: boolean) { mesh.material = v ? mine : alt.material; } };
      }
    } else {
      const sw = demo[name] as { enabled?: boolean } | undefined; // (taa, rays)
      toggle = sw && typeof sw.enabled === 'boolean' ? { get visible() { return sw.enabled!; }, set visible(v: boolean) { sw.enabled = v; } } : demo.scene.getObjectByName(name);
    }
    if (!toggle) { out[name] = 'not in the scene'; continue; }
    const was = toggle.visible, on: number[] = [], off: number[] = [];
    for (let round = 0; round < 12; round++) {
      const shown = round % 2 === 1;
      toggle.visible = shown;
      for (let i = 0; i < frames; i++) {
        await demo.renderFrame();
        const ms = await gpu();
        if (i >= 5) (shown ? on : off).push(ms); // (the first frames after a switch settle)
      }
    }
    toggle.visible = was;
    out[name] = { on: median(on), off: median(off), cost: +(median(on) - median(off)).toFixed(2) };
  }
  return out;
}
