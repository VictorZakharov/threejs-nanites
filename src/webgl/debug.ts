// The WebGL mode's debug colours (the menu's, L; ?debug=), as draw.ts's _debugColour where they mean something here:
// 2 = level (the near levels green to red by their order, the impostors red; the statues by their cut), 3 = tree,
// 4 = type (unlit flat ids: src/type-masks.ts hides the ground and grass, drops the fog, tone mapping and god rays).
// No 1 (clusters) and 5 (rasterizer): the near trees are whole DAG cuts, and there's no software rasterizer.
import { fract, mix, select, uniform, vec3 } from 'three/tsl';
import { TYPE_IDS } from '../nanite-lib/index.ts';
import { iAf, typeOfF, hashOf } from './instanced.ts';
import type { Vec3 } from '../types.ts';

export const DEBUG_MODES = [0, 2, 3, 4];
const asked = Number(new URLSearchParams(location.search).get('debug') ?? 0);
export const debug = uniform(DEBUG_MODES.includes(asked) ? asked : 0);
/** The drawing mesh's level, 0 (finest) .. 1 (impostors), from its `userData.glLevel` (the materials are shared). */
const levelOf = uniform(0).onObjectUpdate(({ object }) => (object?.userData.glLevel as number | undefined) ?? 0);

/** shading.ts typeId by a float select chain . */
const typeColour = (): Vec3 => TYPE_IDS.slice(0, -1).reduceRight<Vec3>((acc, c, i) => select(typeOfF.equal(i), vec3(c[0], c[1], c[2]), acc),
  vec3(TYPE_IDS[TYPE_IDS.length - 1][0], TYPE_IDS[TYPE_IDS.length - 1][1], TYPE_IDS[TYPE_IDS.length - 1][2]));

function colourOf(): Vec3 {
  const h = hashOf(iAf);
  const palette = vec3(h, fract(h.mul(17.31)), fract(h.mul(43.77)));
  const levelRamp = mix(vec3(0.1, 0.9, 0.2), vec3(1.0, 0.15, 0.1), levelOf);
  return select(debug.equal(4), typeColour(), select(debug.equal(2), levelRamp, palette));
}

/** The material's colour and emissive with the debug colours: lit for 2 and 3, unlit (emissive only) for 4. */
export function withDebug(colour: Vec3, emissive: Vec3): { colour: Vec3; emissive: Vec3 } {
  const on = debug.greaterThan(0.5), types = debug.equal(4), dbg = colourOf();
  return {
    colour: select(types, vec3(0), select(on, dbg, colour)),
    emissive: select(types, dbg, select(on, vec3(0), emissive)),
  };
}

/** Sets a mesh's level for the debug colours (`k` of `n` levels; the impostors are `n`). */
export const setLevel = (mesh: { userData: Record<string, unknown> }, k: number, n: number): void => {
  mesh.userData.glLevel = n > 0 ? k / n : 0;
};
