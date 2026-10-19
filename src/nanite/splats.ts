// Tiny impostors splatted in compute into the software rasterizer's visibility buffer (Nanite's way with tiny
// triangles), instead of drawn as quads.
//
// From high up nearly every tree is an impostor a pixel or two wide: a phone at 9 km drew ~500k quads, and its time
// followed their count, not its pixels (issue #2): 4 vertex shader runs, triangle setup and a 2x2 quad of alpha-
// tested fragments for a tree covering a couple of pixels. The instance pass (culling.ts) lists an impostor
// narrower than `?splatpx=` (3) pixels here instead of in the impostor draw; then, with the software rasterizer's
// passes (softraster.ts):
//   depth  one thread per splat walks the pixel centres of its quad (as the impostor draw places it: the same
//          size, elevation tiles, MIN_PX enlargement and thinning), tests the atlas alpha there as the impostor
//          material does, and writes its view depth (atomicMin), one depth for the whole quad
//   id     the same walk; where its depth won: atomicMax of SPLAT_BIT + its slot
//   resolve  a fullscreen quad (phase 2 layer) shades the pixels whose id has SPLAT_BIT as the impostor material
//          does: albedo and normal atlases relit with Lambert, impGain, tint, autumn, the same shadow and fog.
// The splats go in the impostor list from its top down (another buffer would be a 9th in the instance pass).
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Discard, storage, uniform, uniformArray, instanceIndex, screenCoordinate, positionGeometry, output,
  cameraViewMatrix, uint, int, float, vec2, vec3, vec4, uvec2, min, max, clamp, mix, smoothstep, select, hash, length,
  normalize, cross, abs, asin, cos, sin, log2, texture, atomicMin, atomicMax, atomicLoad, floatBitsToUint,
} from 'three/tsl';
import type { ComputeNode } from 'three/webgpu';
import { curve } from '../planet.ts';
import { ELEVATIONS, IMPOSTOR_CUT, TILE_W, TILE_H, atlasLayout } from '../impostors.ts';
import type { ImpostorAtlas } from '../impostors.ts';
import { GROW, ELEV_STEP, IMP_DITHER, IMP_COV, deg, keepShare, impostorCov, impostorShare } from './billboards.ts';
import { MIN_PX, PHASE2_LAYER, SPLAT, SPLAT_BIT, WG, minU, minI, maxI } from './constants.ts';
import { MAX_PIXELS } from './softraster.ts';
import { treeTint, ditherAlt, typeId, mipBias } from './shading.ts';
import { autumnOf, autumnColour } from '../autumn.ts';
import { setEmissive, asReceivedShadow, floatBits } from '../three-gaps.ts';
import type { NaniteForest } from './forest.ts';
import type { Bool, Float, Uint, Vec2, Vec3 } from '../types.ts';
import type { Shading } from './types.ts';

const params = new URLSearchParams(location.search);
const MAX_BOX = 16; // a splat walks at most this many pixels a side (a 3 px wide tree is ~6-9 px tall)
/** Debug 5 colour of the splatted impostors (the software-rasterized clusters are orange). */
const SPLAT_DEBUG = vec3(0, 0.8, 1);

/** Where an impostor's quad is (as _impostorQuad places it) and its tiles, from its tree (see shape). */
interface Shape {
  inst: Uint;
  type: Uint;
  pivot: Vec3;
  dir: Vec3; // towards the camera
  j: Float; // the lower of the two elevation tiles it blends (ELEVATIONS index)
  blend: Float; // the upper tile's weight
  grow: Float;
  cov: Float; // its coverage scale (impostorCov, impostorShare)
  shared: Bool; // drawn at all (impostorShare)
  wPx: Float; // its width on screen before the MIN_PX enlargement
  w0: Float; // the frame's size (m)
  h0: Float;
}

/** A shape's quad on screen: origin and edges (pixels, y down) and the inverse mapping. */
interface Quad {
  o: Vec2;
  ex: Vec2;
  ey: Vec2;
  det: Float;
  depth: Float; // view depth of its centre
  keep: Bool; // (sub-MIN_PX trees: a share of them, as the impostor draw)
  right: Vec3; // its basis
  up: Vec3;
  rightN: Vec3; // right mirrored with the texture (for the normals)
  w: Float;
  h: Float;
  flip: Bool;
}

export class Splats {
  readonly forest: NaniteForest;
  /** On this frame (see begin). */
  readonly on = uniform(0, 'uint');
  /** Switched on (`?splat=0` off, the profile's switch; 0 until the atlas is baked: main.ts). */
  readonly enabled = { value: 0 };
  readonly wanted = params.get('splat') !== '0';
  /**
   * Off (set per frame, see SPLAT_ALTITUDE in main.ts): lower down there are few tiny impostors, and the passes cost
   * ~0.05 ms with none (1080p on the dev GPU: +0.06..0.13 ms from 450 m to 1.8 km up, -0.13 at 8.8 km; from 2 km).
   */
  idle = false;
  /** Impostors narrower than this (pixels, before the MIN_PX enlargement) are splatted. */
  readonly px = uniform(Number(params.get('splatpx') ?? 3));
  readonly growArr = uniformArray<'float'>(GROW, 'float');
  readonly dispatchAttr = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4);
  args: ComputeNode | null = null;
  depthPass: ComputeNode | null = null;
  idPass: ComputeNode | null = null;
  resolveMesh: THREE.Mesh | null = null;

  constructor(forest: NaniteForest) {
    this.forest = forest;
  }

  /** Tree inst's impostor: where its quad is and how big (the impostor draw's vertex shader, _impostorQuad). */
  shape(inst: Uint): Shape {
    const f = this.forest, u = f.u;
    const a = f._a(inst), b = f._b(inst);
    const type = uint(b.z);
    const fr = f.impFrame.element(type);
    const s = a.w;
    const w0 = fr.x.mul(s), h0 = fr.y.mul(s);
    const pivot = a.xyz.add(vec3(0, h0.mul(0.5), 0)).toVar();
    const toCam = u.camPos.sub(pivot).toVar();
    const dir = toCam.normalize().toVar();
    const elev = asin(clamp(dir.y, -1, 1)).div(deg);
    const mid = ELEV_STEP / 2;
    const j = clamp(elev.sub(mid).div(ELEV_STEP).round(), 0, ELEVATIONS.length - 2).toVar();
    const blend = smoothstep(mid - 7.5, mid + 7.5, elev.sub(j.mul(ELEV_STEP))).toVar();
    const ju = uint(j);
    const grow = mix(this.growArr.element(ju), this.growArr.element(ju.add(1)), blend).toVar();
    const wPx = w0.mul(grow).mul(u.projScale).div(max(length(toCam), 0.1)).toVar();
    const share = impostorShare(inst, impostorCov(fr, elev), wPx);
    return { inst, type, pivot, dir, j, blend, grow, cov: share.cov.toVar(), shared: share.k.greaterThan(0), wPx, w0, h0 };
  }

  /** True if tree i, an impostor `px` tall (switching at `swPx`), is splatted (the instance pass and phase 2). */
  wants(i: Uint, px: Float, swPx: Float): Bool {
    return this.on.equal(1).and(px.lessThan(swPx)).and(this.shape(i).wPx.lessThan(this.px));
  }

  /** The shape's quad on screen (as the impostor draw places it: its corners through the same camera). */
  quad(sh: Shape): Quad {
    const sw = this.forest.sw;
    const enlarge = max(float(MIN_PX).div(max(sh.wPx, 1e-3)), 1);
    const g = sh.grow.mul(enlarge);
    const w = sh.w0.mul(g).toVar(), h = sh.h0.mul(g).toVar();
    const right = vec3(sh.dir.z, 0, sh.dir.x.negate()).add(vec3(1e-4, 0, 0)).normalize().toVar();
    const up = cross(sh.dir, right).toVar();
    const flip = hash(sh.inst).greaterThan(0.5); // (mirrored as in the impostor draw)
    const clip = (cx: number, cy: number) => sw.viewProj.mul(vec4(curve(sh.pivot.add(right.mul(w.mul(cx - 0.5))).add(up.mul(h.mul(cy - 0.5)))), 1));
    const screen = (c: ReturnType<typeof clip>): Vec2 => vec2(c.x.div(c.w).mul(0.5).add(0.5).mul(sw.size.x), c.y.div(c.w).mul(-0.5).add(0.5).mul(sw.size.y));
    const o = screen(clip(0, 0)).toVar();
    const ex = screen(clip(1, 0)).sub(o).toVar(), ey = screen(clip(0, 1)).sub(o).toVar();
    const depth = sw.viewProj.mul(vec4(curve(sh.pivot), 1)).w.toVar();
    const keep = sh.shared.and(sh.wPx.greaterThanEqual(MIN_PX).or(hash(sh.inst.add(7)).lessThan(keepShare(sh.wPx))));
    return { o, ex, ey, det: ex.x.mul(ey.y).sub(ex.y.mul(ey.x)).toVar(), depth, keep, right, up, rightN: select(flip, right.negate(), right), w, h, flip };
  }

  /** Where pixel point p is on the quad: (0..1, 0..1) inside, x along right, y up (the quad is a parallelogram). */
  at(q: Quad, p: Vec2): Vec2 {
    const d = p.sub(q.o);
    return vec2(d.x.mul(q.ey.y).sub(d.y.mul(q.ey.x)), q.ex.x.mul(d.y).sub(q.ex.y.mul(d.x))).div(q.det);
  }

  /** The atlas mip level the impostor draw samples here (the larger texel step of a pixel step in x or y). */
  lod(q: Quad): Float {
    const dx = vec2(q.ey.y.mul(TILE_W), q.ex.y.negate().mul(TILE_H)).div(q.det);
    const dy = vec2(q.ey.x.negate().mul(TILE_W), q.ex.x.mul(TILE_H)).div(q.det);
    return log2(max(max(length(dx), length(dy)), 1e-6)).add(mipBias);
  }

  /** Builds the passes and the resolve (before the atlas is baked: it's filled in place); `shadow`: the impostors' shadow node. */
  build(atlas: ImpostorAtlas, shading: Shading & { shadow(pos: Vec3): unknown }): THREE.Mesh {
    const f = this.forest, n = f.instanceCount;
    const ctr = f.mainCtr;
    const count = minU(ctr.ro.element(SPLAT), n);
    const disp = storage(this.dispatchAttr, 'uint', 4);
    this.args = Fn(() => {
      disp.element(0).assign(minU(ctr.rw.element(SPLAT), n).add(WG - 1).div(WG));
    })().compute(1, [1]);
    const samples = this._atlasSampler(atlas);
    const list = storage(f.main.impListAttr, 'uint', n).toReadOnly();
    const sw = f.sw;
    const depthA = storage(sw.depthAttr, 'uint', MAX_PIXELS).toAtomic();
    const idA = storage(sw.idAttr, 'uint', MAX_PIXELS).toAtomic();
    const pass = (mode: 'depth' | 'id') => Fn(() => {
      const k = instanceIndex;
      If(k.lessThan(count), () => {
        const sh = this.shape(list.element(uint(n - 1).sub(k)).toVar());
        const q = this.quad(sh);
        If(q.keep.and(q.depth.greaterThan(sw.near)).and(abs(q.det).greaterThan(1e-6)), () => {
          const W = int(sw.size.x), H = int(sw.size.y);
          const c = [q.o, q.o.add(q.ex), q.o.add(q.ey), q.o.add(q.ex).add(q.ey)];
          const lo = min(min(c[0], c[1]), min(c[2], c[3])), hi = max(max(c[0], c[1]), max(c[2], c[3]));
          const x0 = maxI(int(lo.x.sub(0.5).ceil()), int(0)).toVar(), y0 = maxI(int(lo.y.sub(0.5).ceil()), int(0)).toVar();
          const x1 = minI(minI(int(hi.x.sub(0.5).floor()), W.sub(1)), x0.add(MAX_BOX - 1)).toVar();
          const y1 = minI(minI(int(hi.y.sub(0.5).floor()), H.sub(1)), y0.add(MAX_BOX - 1)).toVar();
          const z = floatBits(q.depth, floatBitsToUint).toVar(); // (positive floats order like their bits)
          const lod = mode === 'depth' ? this.lod(q).toVar() : null;
          const rows = { start: y0, end: y1, type: 'int', condition: '<=' } as const;
          const cols = { start: x0, end: x1, type: 'int', condition: '<=' } as const;
          Loop(rows, cols, ({ i: py, j: px }) => {
            const p = vec2(float(px).add(0.5), float(py).add(0.5));
            const t = this.at(q, p).toVar();
            const inside = t.x.greaterThanEqual(0).and(t.x.lessThanEqual(1)).and(t.y.greaterThanEqual(0)).and(t.y.lessThanEqual(1)).toVar();
            const pix = uint(py).mul(uint(W)).add(uint(px));
            if (lod) {
              If(inside, () => {
                inside.assign(samples(sh, q, t, lod).pass(p));
              });
              If(inside, () => atomicMin(depthA.element(pix), z));
            } else {
              // (no alpha test: a depth equal to its own means it passed it)
              If(inside.and(atomicLoad(depthA.element(pix)).equal(z)), () => atomicMax(idA.element(pix), k.add(uint(SPLAT_BIT))));
            }
          });
        });
      });
    })().compute(n, [WG]).setName('splats');
    this.depthPass = pass('depth');
    this.idPass = pass('id');
    return this._buildResolve(atlas, samples, shading);
  }

  /**
   * The atlas lookups of a pixel (quad point t, mip level lod) as the impostor material does them: its two elevation
   * tiles, the coverage-preserving alpha and the union of the silhouettes (see _impostorQuad); `pass(p)` is its
   * alpha test at pixel point p (by coverage against the moving dither under TAA, else the cut-out).
   */
  _atlasSampler(atlas: ImpostorAtlas) {
    const nTypes = atlas.frames.length;
    const { cols, rows } = atlasLayout(nTypes);
    const { levels } = atlas.coverage, scaleArr = atlas.scales; // (filled by impostorCoverage)
    return (sh: Shape, q: Quad, t: Vec2, lod: Float) => {
      const vUv = vec2(select(q.flip, t.x.oneMinus(), t.x), t.y.oneMinus()); // (within the tile; stored flipped)
      const ks = [sh.j, sh.j.add(1)], wts = [sh.blend.oneMinus(), sh.blend];
      const uv = ks.map((k) => {
        const tile = float(sh.type).add(k.mul(nTypes)), row = tile.div(cols).floor(), col = tile.sub(row.mul(cols));
        return vUv.add(vec2(col, row)).div(vec2(cols, rows));
      });
      const s = uv.map((c) => texture(atlas.texture, c).level(lod));
      const lc = clamp(lod, 0, levels - 1.001);
      const scaleOf = (tile: Uint): Float => {
        const i0 = tile.mul(levels).add(uint(lc.floor()));
        return mix(scaleArr.element(i0), scaleArr.element(i0.add(1)), lc.fract());
      };
      const a = s.map((sk, i) => sk.a.mul(scaleOf(sh.type.add(uint(ks[i]).mul(nTypes)))).mul(clamp(wts[i].mul(2), 0, 1)));
      const coverage = min(max(s[0].a.mul(clamp(wts[0].mul(2), 0, 1)), s[1].a.mul(clamp(wts[1].mul(2), 0, 1))), 1);
      const pass = (p: Vec2): Bool => (IMP_DITHER ? coverage.mul(IMP_COV).mul(sh.cov).greaterThan(ditherAlt(p)) : min(max(a[0], a[1]), 1).greaterThanEqual(IMPOSTOR_CUT).and(sh.cov.greaterThan(ditherAlt(p))));
      return { uv, s, a, elev: ks.map((k) => k.mul(ELEV_STEP)), pass };
    };
  }

  /** The fullscreen quad shading the splatted pixels (phase 2 layer), as the impostor material (buildImpostorMesh). */
  _buildResolve(atlas: ImpostorAtlas, samples: ReturnType<Splats['_atlasSampler']>, shading: Shading & { shadow(pos: Vec3): unknown }): THREE.Mesh {
    const f = this.forest, u = f.u, sw = f.sw, n = f.instanceCount;
    const ids = storage(sw.idAttr, 'uint', MAX_PIXELS).toReadOnly();
    const list = storage(f.main.impListAttr, 'uint', n).toReadOnly();
    const pix = uvec2(screenCoordinate.xy);
    const id = ids.element(pix.y.mul(uint(sw.size.x)).add(pix.x));
    const k = minU(id.sub(uint(SPLAT_BIT)), n - 1);
    const sh = this.shape(list.element(uint(n - 1).sub(k)));
    const q = this.quad(sh);
    const t = clamp(this.at(q, screenCoordinate.xy), 0, 1);
    const tiles = samples(sh, q, t, this.lod(q));
    const wSum = max(tiles.a[0].add(tiles.a[1]), 1e-4);
    // (MSAA-resolved edges are premultiplied by coverage: divide it out)
    const albedo = tiles.s.reduce<Vec3>((acc, s, i) => acc.add(s.rgb.div(max(s.a, 1e-3)).mul(tiles.a[i])), vec3(0)).div(wSum);
    const nWorld = tiles.uv.reduce<Vec3>((acc, uv, i) => {
      const nt = texture(atlas.normals, uv).level(this.lod(q)).xyz;
      const c = cos(tiles.elev[i].mul(deg)), sn = sin(tiles.elev[i].mul(deg));
      const up = nt.y.mul(c).sub(nt.z.mul(sn)), toward = nt.y.mul(sn).add(nt.z.mul(c));
      return acc.add(q.rightN.mul(nt.x).add(q.up.mul(up)).add(sh.dir.mul(toward)).mul(tiles.a[i]));
    }, vec3(0));
    const gains = f.impGains!;
    const gS = gains.side.element(sh.type), gT = gains.top.element(sh.type);
    const gain = tiles.elev.reduce<Vec3>((acc, e, i) => acc.add(mix(gS, gT, e.div(90)).mul(tiles.a[i])), vec3(0)).div(wSum);
    const tint = treeTint(sh.inst);
    const autumn = select(f.textures.leafLayerOf(sh.type).equal(3), float(0), autumnOf(f._b(sh.inst).w));
    const green = albedo.mul(vec3(tint.mul(0.92), tint, tint.mul(0.8))).mul(gain);
    const col = autumnColour(green, autumn, smoothstep(0, 0.03, green.g.sub(max(green.r, green.b))));
    const onQuad = sh.pivot.add(q.right.mul(t.x.sub(0.5).mul(q.w))).add(q.up.mul(t.y.sub(0.5).mul(q.h)));
    const world = curve(onQuad);

    const mat = new THREE.MeshLambertNodeMaterial();
    mat.vertexNode = vec4(positionGeometry.xy, 0, 1);
    mat.fog = false;
    mat.colorNode = Fn(() => {
      Discard(id.lessThan(uint(SPLAT_BIT)).or(this.on.equal(0)));
      return vec4(select(u.debug.greaterThan(0), vec3(0), col), 1);
    })();
    mat.normalNode = normalize(cameraViewMatrix.mul(vec4(nWorld.add(sh.dir.mul(1e-3)), 0)).xyz);
    setEmissive(mat, select(u.debug.equal(5), SPLAT_DEBUG, select(u.debug.equal(4), typeId(sh.type), select(u.debug.greaterThan(0), vec3(0.9, 0.2, 0.8), col.mul(0.12)))));
    // (the shadow map on its sun side, past its own caster quad: see vShadowPos)
    mat.receivedShadowPositionNode = curve(onQuad.add(u.sunDir.mul(q.w.add(q.h).mul(0.5))));
    mat.receivedShadowNode = asReceivedShadow(shading.shadow(world));
    const clip = sw.viewProj.mul(vec4(world, 1));
    mat.depthNode = clip.z.div(clip.w);
    const fog = shading.fog(world, clip.w);
    mat.outputNode = vec4(mix(output.rgb, fog.color, fog.factor), output.a);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mesh = (this.resolveMesh = new THREE.Mesh(geo, mat));
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.layers.set(PHASE2_LAYER);
    mesh.name = 'nanite-splat-resolve';
    return mesh;
  }

  /** Per frame, after SoftRaster.begin (its visibility buffer is needed): on or off, and the resolve with it. */
  begin(): void {
    this.on.value = this.enabled.value === 1 && !this.idle && this.forest.sw.on.value === 1 ? 1 : 0;
    if (this.resolveMesh) this.resolveMesh.visible = this.on.value === 1;
  }
}
