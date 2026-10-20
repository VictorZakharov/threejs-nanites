// The ground near the viewer: the forest floor's maps (floor-maps.ts: soil, twigs and pebbles, after last-stand) with
// the fallen leaves of the tree above laid over them (floor-leaves.ts: a layer per kind, chosen per spot by the litter
// map, litter-map.ts) and parallax relief (relief.ts). The leaves take their tree's shape and autumn colour, as many as
// it drops (the user: "leaves on the ground matching the trees above them, in shape and colour"); under conifers a
// thick mat of rust-brown sprays. Out in the open the ground keeps its grass colour. Moss is tinted in world space.
import * as THREE from 'three/webgpu';
import {
  texture, positionWorld, float, vec2, vec3, vec4, mix, smoothstep, mx_noise_float, normalWorld,
  cameraViewMatrix, select, dot, max, clamp, textureLoad, ivec2, int, sqrt, fract, log2, length, Fn, If,
} from 'three/tsl';
import type { Float, Vec2, Vec3, Vec4 } from '../types.ts';
import { FLOOR_TILE, HEIGHT_CM, type PBRData } from './floor-maps.ts';
import { LEAF_KINDS, LEAF_TILE } from './floor-leaves.ts';
import { workerError } from '../worker-error.ts';
import { LITTER_SIZE, LITTER_RES } from './litter-map.ts';
import { reliefUv } from './relief.ts';
import { cobbles, cobbleAverage, cobblePatches, cobbleFootprint, COBBLES_GONE } from './cobbles.ts';
import { roadDistanceNode } from '../road.ts';
import { footprint } from '../nanite-lib/index.ts';
import { underGrass } from '../grass.ts';
import { detailPos } from '../planet.ts';
import { meadowColour } from '../terrain.ts';

const TILE = FLOOR_TILE; // m a tile (1024 px: ~5 mm a texel)
const LEAF_SIZE = 1024; // (the leaf layers' texels: the floor maps' size)
const RELIEF = { depth: HEIGHT_CM / 100, tile: TILE, fade: 40 };

export interface FloorMaps {
  map: THREE.DataTexture;
  normal: THREE.DataTexture;
  height: THREE.DataTexture;
  leaves: THREE.DataArrayTexture; // per kind of leaf (LEAF_KINDS): height, normal, key
  /** Resolves once the workers have filled the textures: each worker's own time (ms: the soil's, then each kind of
   * leaf's) and when the last was done (ms after the start). */
  ready: Promise<{ ms: number[]; doneMs: number }>;
}

/**
 * Starts building the maps in workers (the soil's, and a layer per kind of leaf, in parallel). The textures are there
 * at once, empty until `ready`: the floor's shader, the slowest to compile, compiles against them from the start.
 */
export function loadFloorMaps(): FloorMaps {
  const t0 = performance.now(), ms: number[] = [];
  const job = <T>(leaf: number | null): Promise<T> => new Promise((resolve, reject) => {
    const w = new Worker(new URL('./floor-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ out: T; ms: number }>) => {
      w.terminate();
      ms[leaf === null ? 0 : leaf + 1] = Math.round(e.data.ms);
      resolve(e.data.out);
    };
    w.onerror = (e) => reject(workerError(`floor-worker (${leaf === null ? 'soil' : LEAF_KINDS[leaf]})`, e));
    w.postMessage({ leaf, size: LEAF_SIZE });
  });
  const floor = job<PBRData>(null);
  const layers = LEAF_KINDS.map((_, i) => job<Uint8ClampedArray<ArrayBuffer>>(i));
  const tex = (srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(new Uint8Array(LEAF_SIZE * LEAF_SIZE * 4), LEAF_SIZE, LEAF_SIZE);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const n = LEAF_SIZE * LEAF_SIZE * 4;
  const leaves = new THREE.DataArrayTexture(new Uint8Array(n * LEAF_KINDS.length), LEAF_SIZE, LEAF_SIZE, LEAF_KINDS.length);
  leaves.wrapS = leaves.wrapT = THREE.RepeatWrapping;
  leaves.magFilter = THREE.LinearFilter;
  leaves.minFilter = THREE.LinearMipmapLinearFilter;
  leaves.generateMipmaps = true;
  leaves.needsUpdate = true;
  const maps = { map: tex(true), normal: tex(false), height: tex(false), leaves };
  const fill = (t: THREE.DataTexture | THREE.DataArrayTexture, px: Uint8ClampedArray, at = 0): void => {
    (t.image.data as Uint8Array).set(px, at);
    t.needsUpdate = true;
  };
  const ready = Promise.all([floor, Promise.all(layers)]).then(([d, ls]) => {
    if (d.size !== LEAF_SIZE) throw new Error(`floor maps of ${d.size} px, the textures are ${LEAF_SIZE}`);
    fill(maps.map, d.albedo);
    fill(maps.normal, d.normal);
    fill(maps.height, d.rough);
    ls.forEach((px, i) => fill(leaves, px, i * n));
    return { ms, doneMs: Math.round(performance.now() - t0) };
  });
  return { ...maps, ready };
}

/** The litter map (litter-map.ts): its texture and the world xz of its middle. */
export interface LitterInput {
  texture: THREE.Texture;
  center: Vec2;
}

// the leaves' own colours (dry, before the tree's autumn colour; linear x 2 like the maps): oak tan, ash olive,
// aspen ochre, conifer rust-tan (the user's photo)
const KIND_COLOUR = [vec3(0.34, 0.15, 0.034), vec3(0.29, 0.24, 0.044), vec3(0.52, 0.3, 0.026), vec3(0.42, 0.17, 0.08)];

/** The road and the plaza (src/road.ts) at world xz `p`: 1 on the paving, the edge a little ragged. */
const pavedAt = (p: Vec2): Float => float(1).sub(smoothstep(-0.12, 0.12, roadDistanceNode(p).add(mx_noise_float(p.mul(1.7)).mul(0.25))));

/**
 * The ground seen from high up (src/terrain.ts, `terrain-high`): what `applyFloor` comes to past 200 m, where the
 * litter, its relief and the moss have faded out and the cobbles are finer than the pixels: the ground's own colour,
 * the paving's average on the road. Its shader computed all of them for every pixel and multiplied them by 0 (8
 * noises, a Voronoi, ~10 texture reads): a phone 9 km up spent 4.3 of 15.5 ms on the terrain and sky.
 */
export function applyFarFloor(mat: THREE.MeshStandardNodeMaterial, detail: { slope: Float; normalView: Vec3 }): void {
  const p = positionWorld.xz;
  mat.colorNode = mix(meadowColour(detail.slope), cobbleAverage(cobblePatches(p)), pavedAt(p));
  mat.normalNode = detail.normalView; // (the detailed grid's: the coarse grids shade like it)
  mat.roughness = 0.95;
}

/**
 * Gives the terrain material the floor: `meadow` is its own (grass / dirt) colour, `coverMap` the cover map at the
 * world position (forestDensity: red canopy cover, green the fallen leaves' amount, blue their autumn level / 2: used
 * past the litter map), `litter` the litter map.
 */
export function applyFloor(mat: THREE.MeshStandardNodeMaterial, maps: FloorMaps, meadow: Vec3, coverMap: Vec4, litter: LitterInput): void {
  // Only the meadow colour and the far shading reach past 200 m (`under` is 0 there) and off the road (`paved` 0): the
  // litter, its relief, the moss and the cobbles (8 noises, a Voronoi, ~10 texture reads) are computed in branches.
  // WGSL takes derivatives in uniform control flow only, so they're taken first (`toVar`: evaluated here, not where
  // first used) and the branches sample by gradient or level. The normal's lean is a variable assigned beside the
  // colour (`tilt`, declared before the branches: a node first built inside one is out of scope for the normal).
  const tilt = vec2(0).toVar(); // (x, z: added to the terrain's normal)
  mat.colorNode = Fn(() => {
    tilt.assign(vec2(0));
    const p = positionWorld.xz.toVar();
    const dist = positionWorld.sub(detailPos).length().toVar(); // (the fades: src/planet.ts)
    const cover = coverMap.toVar(); // (a filtered read: here, not in a branch; the far shading reads it too)
    const uv0 = p.div(TILE).toVar();
    const duv = { x: uv0.dFdx().toVar(), y: uv0.dFdy().toVar() }; // (the relief's)
    const dx = duv.x.mul(footprint()).toVar(), dy = duv.y.mul(footprint()).toVar(); // (for the output's pixels)
    const cfp = cobbleFootprint(p);
    const colour = meadow.mul(underGrass(p, cover.r, dist)).toVar(); // (in the blades' shade: src/grass.ts)
    If(dist.lessThan(LITTER_GONE), () => {
      const fl = floorAt(maps, litter, p, dist, cover, uv0, duv, dx, dy);
      If(fl.under.greaterThan(0), () => {
        const { floor, nm } = fl.litter();
        colour.assign(mix(colour, floor, fl.under));
        // the maps' normals on the terrain's (v runs along +z: dh/dz = g)
        tilt.assign(vec2(nm.x, nm.y.negate()).mul(fl.under.mul(0.8)));
      });
    });
    // the road and the plaza (src/road.ts): cobbles, the edge a little ragged
    const paved = pavedAt(p).toVar();
    If(paved.greaterThan(0).and(cfp.px.lessThan(COBBLES_GONE)), () => {
      const cob = cobbles(p, cfp);
      colour.assign(mix(colour, cob.colour, paved));
      tilt.assign(mix(tilt, cob.tilt, paved));
    }).Else(() => {
      colour.assign(mix(colour, cobbleAverage(cobblePatches(p)), paved));
      tilt.assign(tilt.mul(float(1).sub(paved)));
    });
    return colour;
  })();
  // (built after the colour: the lighting comes after the diffuse colour in three's NodeMaterial.setup)
  const nW = normalWorld.add(vec3(tilt.x, 0, tilt.y)).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nW, 0)).xyz.normalize();
  mat.roughness = 0.95;
}

/** Past this distance from the viewer the litter is gone (`under` fades out over 80..200 m). */
const LITTER_GONE = 200;

/**
 * The litter near the viewer: `under`, how much of it shows (the canopy's cover or a tree's fall, fading out by
 * `LITTER_GONE`), and `litter()`, its colour (soil, leaves, moss) and the maps' normal (x, y: -dh/du, +dh/dv). Built
 * inside the floor's branch: no derivatives (`duv` the plain uv's, `dx`, `dy` the output pixels').
 */
function floorAt(maps: FloorMaps, litter: LitterInput, p: Vec2, dist: Float, coverMap: Vec4, uv0: Vec2,
  duv: { x: Vec2; y: Vec2 }, dx: Vec2, dy: Vec2): { under: Float; litter: () => { floor: Vec3; nm: Vec3 } } {
  // the tree above (looked up a little off, so the crowns' edges in the half-metre texels are ragged, not square)
  const jit = vec2(mx_noise_float(p.mul(0.8)), mx_noise_float(p.mul(0.8).add(31))).mul(0.7);
  const luv = p.add(jit).sub(litter.center).div(LITTER_SIZE).add(0.5);
  const inMap = float(1).sub(smoothstep(0.42, 0.49, max(luv.x.sub(0.5).abs(), luv.y.sub(0.5).abs()))).toVar();
  const ti = clamp(luv.mul(LITTER_RES).floor(), 0, LITTER_RES - 1);
  const cell = textureLoad(litter.texture, ivec2(int(ti.x), int(ti.y))).toVar();
  // (under a lone tree too: by the litter map's own amount; with `amount`, which takes in the cover map's average over
  // the map's fading edge, open ground showed a brown band along the square's edge, moving with it: the user)
  const fallen = inMap.mul(smoothstep(0.08, 0.3, cell.g));
  // under the canopy (and under lone trees) the litter, near the viewer: far away the ground's own colour, darkened by
  // the far shading (the litter's average brown turned the whole forest floor brown from the air); the meadow keeps
  // its plain colour (the litter's pattern in it read as pale stamped leaves up close)
  const under = max(smoothstep(0.3, 0.75, coverMap.r), fallen).mul(float(1).sub(smoothstep(80, LITTER_GONE, dist))).toVar();
  return { under, litter: () => {
    const amount = mix(coverMap.g.mul(1.4).min(1), cell.g, inMap);
    const level = mix(coverMap.b, cell.b, inMap).mul(2); // (0 green, 1 yellow, 2 red)
    const forced = new URLSearchParams(location.search).get('litterkind'); // (debug: one kind everywhere, 0..3)
    const kind = (forced !== null ? float(Number(forced)) : select(inMap.greaterThan(0.5), max(cell.r.mul(255).round().sub(1), float(0)), float(0))).toVar();
    const kindI = int(kind).toVar(); // (the layer: an i32 variable, or the array texture's sample got an f32 index)
    const isNeedle = kind.equal(3);
    const ls = select(isNeedle, float(TILE / LEAF_TILE.pine), float(1)).toVar(); // (the conifer layer's finer tile)

    // up close each leaf by its key, further away (the mips average the keys) by the share
    const far = smoothstep(15, 45, dist);
    // (an explicit mip level: three's WGSL for grad() on an array texture passes the layer as a float, which fails)
    const size = maps.leaves.image.width;
    const leafAt = (q: Vec2, dx: Vec2, dy: Vec2): Vec4 =>
      // (by the footprint's area, not its longest side: at a grazing angle that blurred the needles away; TAA smooths it)
      texture(maps.leaves, q.mul(ls)).depth(kindI).level(log2(max(sqrt(length(dx).mul(length(dy))).mul(ls).mul(size), 1)));
    const lies = (lf: Vec4): Float => select(lf.r.greaterThan(0.003).and(lf.a.sub(0.1).div(0.9).lessThan(amount)), float(1), float(0));
    const sample = (_t: THREE.Texture, q: Vec2, dx: Vec2, dy: Vec2): Float => {
      const lf = leafAt(q, dx, dy);
      return max(texture(maps.height, q).grad(dx, dy).r, lf.r.mul(lies(lf)));
    };
    const uv = reliefUv(maps.height, uv0, duv.x, duv.y, RELIEF, sample, under); // (relief only in the litter)
    const raw = texture(maps.map, uv).grad(dx, dy).rgb.mul(2); // (last-stand's colours, for our light)
    const baseH = texture(maps.height, uv).grad(dx, dy).r;
    const nmBase = texture(maps.normal, uv).grad(dx, dy).xyz.mul(2).sub(1); // (r: -dh/du, g: +dh/dv, b: up)
    const lf = leafAt(uv, dx, dy);
    const near = lies(lf).mul(select(lf.r.greaterThan(baseH), float(1), float(0)));
    const on = mix(near, amount.mul(0.85), far);

    // the leaf's colour: its kind's, darker in the lower (older) layers, varied per leaf; fresh ones in the tree's colour
    const kindCol = select(kind.equal(0), KIND_COLOUR[0], select(kind.equal(1), KIND_COLOUR[1], select(kind.equal(2), KIND_COLOUR[2], KIND_COLOUR[3])));
    const keyN = mix(lf.a, float(0.6), far);
    const shade = mix(float(0.55), float(1.1), keyN).mul(fract(keyN.mul(37.1)).mul(0.3).add(0.85));
    const lum = dot(kindCol, vec3(0.3, 0.59, 0.11));
    const tint = select(level.lessThan(1), mix(vec3(1.0, 1.5, 0.3), vec3(2.4, 1.75, 0.25), level), mix(vec3(2.4, 1.75, 0.25), vec3(2.5, 0.55, 0.2), level.sub(1)));
    const fresh = fract(keyN.mul(53.7));
    const turn = select(isNeedle, float(0), fresh.mul(0.6).add(0.3).mul(smoothstep(0, 0.5, level).mul(0.5).add(0.5)));
    const leafCol = mix(kindCol, tint.mul(lum), turn).mul(shade);
    const litterCol = mix(raw, leafCol, on);
    const nl = vec3(lf.g.mul(2).sub(1), lf.b.mul(2).sub(1), 0);
    const nm = mix(nmBase, vec3(nl.x, nl.y, sqrt(max(float(1).sub(dot(nl, nl)), 0))), near.mul(float(1).sub(far)));

    // moss over the litter in world space (large patches: a texture would tile), less where the leaves lie thick
    const mossV = mx_noise_float(p.mul(0.11)).mul(0.3).add(mx_noise_float(p.mul(0.37).add(7)).mul(0.15)).add(0.5);
    const moss = smoothstep(0.45, 0.7, mossV).mul(0.5).mul(float(1).sub(on.mul(0.8)));
    const mossCol = vec3(0.045, 0.09, 0.025).mul(mx_noise_float(p.mul(3.1)).mul(0.3).add(1));
    return { floor: mix(litterCol, mossCol, moss), nm };
  } };
}
