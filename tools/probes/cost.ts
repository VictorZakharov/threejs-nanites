// What a part of the scene costs on the GPU, in one page: `?cost=` names objects of the scene (default `grass`), and
// each is switched off and on in alternating blocks of `?costframes=` (40) frames, 6 of each, the median GPU ms of
// each state (render + compute timer queries; the WebGL mode's too). Back-to-back runs of the same build swung ~2x
// on the dev GPU (WebGL ground 7 or 13 ms), so separate harness variants can't measure a few ms: alternating blocks
// in one page can.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const q = new URLSearchParams(location.search);
  const names = (q.get('cost') ?? 'grass').split(',');
  const frames = Number(q.get('costframes') ?? 40);
  const r = demo.renderer;
  const gpu = async (): Promise<number> => ((await r.resolveTimestampsAsync('render')) ?? 0) + ((demo.webgl ? 0 : await r.resolveTimestampsAsync('compute')) ?? 0);
  const median = (a: number[]): number => +[...a].sort((x, y) => x - y)[a.length >> 1].toFixed(2);
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const obj = demo.scene.getObjectByName(name);
    if (!obj) { out[name] = 'not in the scene'; continue; }
    const was = obj.visible, on: number[] = [], off: number[] = [];
    for (let round = 0; round < 12; round++) {
      obj.visible = round % 2 === 1;
      for (let i = 0; i < frames; i++) {
        await demo.renderFrame();
        const ms = await gpu();
        if (i >= 5) (obj.visible ? on : off).push(ms); // (the first frames after a switch settle)
      }
    }
    obj.visible = was;
    out[name] = { on: median(on), off: median(off), cost: +(median(on) - median(off)).toFixed(2) };
  }
  return out;
}
