// The ground near the viewer: the forest floor's maps (floor-maps.ts: soil, twigs and pebbles, after last-stand) with
// the fallen leaves of the tree above laid over them (floor-leaves.ts: a layer per kind, chosen per spot by the litter
// map, litter-map.ts) and parallax relief (relief.ts). The leaves take their tree's shape and autumn colour, as many as
// it drops (the user: "leaves on the ground matching the trees above them, in shape and colour"); under conifers a
// thick mat of rust-brown sprays. Out in the open the ground keeps its grass colour. Moss is tinted in world space.
import * as THREE from 'three/webgpu';
import {
  texture, positionWorld, cameraPosition, float, vec2, vec3, vec4, mix, smoothstep, mx_noise_float, normalWorld,
  cameraViewMatrix, select, dot, max, clamp, textureLoad, ivec2, int, sqrt, fract, log2, length,
} from 'three/tsl';
import type { Float, Vec2, Vec3, Vec4 } from '../types.ts';
import { FLOOR_TILE, HEIGHT_CM, type PBRData } from './floor-maps.ts';
import { LEAF_KINDS, LEAF_TILE } from './floor-leaves.ts';
import { LITTER_SIZE, LITTER_RES } from './litter-map.ts';
import { reliefUv } from './relief.ts';

const TILE = FLOOR_TILE; // m a tile (1024 px: ~5 mm a texel)
const RELIEF = { depth: HEIGHT_CM / 100, tile: TILE, fade: 40 };

export interface FloorMaps {
  map: THREE.DataTexture;
  normal: THREE.DataTexture;
  height: THREE.DataTexture;
  leaves: THREE.DataArrayTexture; // per kind of leaf (LEAF_KINDS): height, normal, key
}

/** Starts building the maps in a worker; resolves to textures. */
export function loadFloorMaps(): Promise<FloorMaps> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./floor-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<PBRData & { leaves: Uint8ClampedArray<ArrayBuffer> }>) => {
      w.terminate();
      const d = e.data;
      const tex = (px: Uint8ClampedArray, srgb: boolean): THREE.DataTexture => {
        const t = new THREE.DataTexture(new Uint8Array(px.buffer), d.size, d.size);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        t.anisotropy = 8;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.needsUpdate = true;
        return t;
      };
      const leaves = new THREE.DataArrayTexture(new Uint8Array(d.leaves.buffer), d.size, d.size, LEAF_KINDS.length);
      leaves.wrapS = leaves.wrapT = THREE.RepeatWrapping;
      leaves.magFilter = THREE.LinearFilter;
      leaves.minFilter = THREE.LinearMipmapLinearFilter;
      leaves.generateMipmaps = true;
      leaves.needsUpdate = true;
      resolve({ map: tex(d.albedo, true), normal: tex(d.normal, false), height: tex(d.rough, false), leaves });
    };
    w.onerror = (e) => reject(new Error(e.message));
    w.postMessage(null);
  });
}

/** The litter map (litter-map.ts): its texture and the world xz of its middle. */
export interface LitterInput {
  texture: THREE.Texture;
  center: Vec2;
}

// the leaves' own colours (dry, before the tree's autumn colour; linear x 2 like the maps): oak tan, ash olive,
// aspen ochre, conifer rust-tan (the user's photo)
const KIND_COLOUR = [vec3(0.34, 0.15, 0.034), vec3(0.29, 0.24, 0.044), vec3(0.52, 0.3, 0.026), vec3(0.42, 0.17, 0.08)];

/**
 * Gives the terrain material the floor: `meadow` is its own (grass / dirt) colour, `coverMap` the cover map at the
 * world position (forestDensity: red canopy cover, green the fallen leaves' amount, blue their autumn level / 2: used
 * past the litter map), `litter` the litter map.
 */
export function applyFloor(mat: THREE.MeshStandardNodeMaterial, maps: FloorMaps, meadow: Vec3, coverMap: Vec4, litter: LitterInput): void {
  const p = positionWorld.xz;
  const dist = positionWorld.sub(cameraPosition).length();
  // the tree above (looked up a little off, so the crowns' edges in the half-metre texels are ragged, not square)
  const jit = vec2(mx_noise_float(p.mul(0.8)), mx_noise_float(p.mul(0.8).add(31))).mul(0.7);
  const luv = p.add(jit).sub(litter.center).div(LITTER_SIZE).add(0.5);
  const inMap = float(1).sub(smoothstep(0.42, 0.49, max(luv.x.sub(0.5).abs(), luv.y.sub(0.5).abs())));
  const ti = clamp(luv.mul(LITTER_RES).floor(), 0, LITTER_RES - 1);
  const cell = textureLoad(litter.texture, ivec2(int(ti.x), int(ti.y)));
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
  const uv0 = p.div(TILE);
  const fallen = inMap.mul(smoothstep(0.08, 0.3, amount)); // (under a lone tree too)
  const under = max(smoothstep(0.3, 0.75, coverMap.r), fallen).mul(float(1).sub(smoothstep(80, 200, dist)));
  const uv = reliefUv(maps.height, uv0, RELIEF, sample, under); // (relief only in the litter)
  const dx = uv0.dFdx(), dy = uv0.dFdy();
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
  const floor = mix(litterCol, mossCol, moss);
  // under the canopy (and under lone trees) the litter, near the viewer: far away the ground's own colour, darkened by
  // the far shading (the litter's average brown turned the whole forest floor brown from the air); the meadow keeps
  // its plain colour (the litter's pattern in it read as pale stamped leaves up close)
  mat.colorNode = mix(meadow, floor, under);
  // the maps' normals on the terrain's (v runs along +z: dh/dz = g)
  const nW = normalWorld.add(vec3(nm.x, 0, nm.y.negate()).mul(under.mul(0.8))).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nW, 0)).xyz.normalize();
  mat.roughness = 0.95;
}
