// Every WGSL program three.js has compiled so far (vertex, fragment, compute), each as a hash of its code and its
// length, sorted: two builds that should draw the same thing should list the same programs (a refactor's check).
// Generated ids (NodeBuffer_19282...) are renumbered by first appearance before hashing: they count every node made
// before, so they move with any change elsewhere. `--query=shaderdump=1` adds each program's code, renumbered (in
// report.json).
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  await demo.renderOnce();
  type Programs = Record<'vertex' | 'fragment' | 'compute', Map<string, unknown>>;
  const programs = (demo.renderer as unknown as { _pipelines: { programs: Programs } })._pipelines.programs;
  const dump = new URLSearchParams(location.search).get('shaderdump') === '1';
  const fnv = (s: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, '0');
  };
  const renumber = (c: string): string => {
    const ids = new Map<string, string>();
    return c.replace(/\b([A-Za-z]+)_(\d+)(?=Struct\b|\b)/g, (w, name: string) => {
      if (!ids.has(w)) ids.set(w, `${name}_#${ids.size}`);
      return ids.get(w)!;
    });
  };
  const out: Record<string, string[]> = {};
  const code: Record<string, string> = {};
  for (const stage of ['vertex', 'fragment', 'compute'] as const) {
    out[stage] = [...programs[stage].keys()].map(renumber).map((c) => {
      const k = `${fnv(c)} ${c.length}`;
      if (dump) code[`${stage} ${k}`] = c;
      return k;
    }).sort();
  }
  return { counts: Object.fromEntries(Object.entries(out).map(([s, l]) => [s, l.length])), ...out, ...(dump ? { code } : {}) };
}
