// The WGSL three.js generated, for reading: what the shaders really run (the node graph hides what the lights, fog and shadows add,
// and what it builds twice: a select's branches don't share). `programs`: every fragment module so far, largest first, with its
// texture samples and the first varying or texture it names. `?wgsl=` a word its code holds (a varying's name, vImpTile: the
// impostors): every vertex and fragment module with it too, longest first.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const word = new URLSearchParams(location.search).get('wgsl');
  await demo.renderFrame();
  const programs = (demo.renderer as unknown as { _pipelines: { programs: Record<'vertex' | 'fragment', Map<string, unknown>> } })._pipelines.programs;
  const having = (m: Map<string, unknown>): string[] => [...m.keys()].filter((c) => word && c.includes(word)).sort((a, b) => b.length - a.length);
  const list = [...programs.fragment.keys()].sort((a, b) => b.length - a.length).map((c) => ({
    bytes: c.length,
    samples: (c.match(/textureSample\w*\(/g) ?? []).length,
    names: (c.match(/@location\( \d+ \)[^:]*?(\w+) : /g) ?? []).map((v) => v.replace(/.*\s(\w+) : $/, '$1')).slice(0, 4).join(' '),
  }));
  return { programs: list, vertex: having(programs.vertex), fragment: having(programs.fragment) };
}
