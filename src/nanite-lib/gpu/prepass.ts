// The leaves' depth prepass, for where they're many layers deep (issue #12: the 5x zoom over the canopy).
//
// The leaf draws alpha-test (discard) and write depth, so the GPU can't reject a fragment before shading it unless
// something nearer is already in the depth buffer, and their list is in no particular order: every card of a crown
// was lit, shadowed and fogged, most of them hidden. The prepass draws the same leaves first with only their alpha
// test (no colour, no lighting, the vertex shader without last frame's motion), then the leaves again, lit, depth
// tested against it without writing depth: only the front card of each pixel is lit (the same image: the second pass
// still alpha-tests, with the same alpha, so a leaf hidden by none draws where it did). It costs the vertices and the
// alpha test twice, so it pays only where the leaves are dense on screen: on (`auto`) above PREPASS_ON hardware leaf
// triangles per scene pixel, off again under PREPASS_OFF (the counters, read back every READ_MS). `?leafpre=1|0`
// always / never. The two passes' depths match to the bit: a depth-equal second pass with the alpha test draws the
// same image and costs the same (zoomed, the second pass's cost is its vertices); without the alpha test ~0.5% of the
// crowns' pixels came out different, scattered single pixels, which TAA averaged into crowns ~1.5/255 brighter.
import * as THREE from 'three/webgpu';
import { Fn, storage, instanceIndex, vertexIndex, uint, float, vec3, vec4, select, varying, texture } from 'three/tsl';
import { LIST_CAP, STATS, minU } from './constants.ts';
import type { NaniteRenderer } from './renderer.ts';
import type { CullSet, View } from './types.ts';
import { makeLeafAlpha, a2cDither, dither, mipBias } from './shading.ts';

const params = new URLSearchParams(location.search);
const MODE = params.get('leafpre') ?? 'auto';
const [PREPASS_ON, PREPASS_OFF] = (params.get('leafpredensity') ?? '1.35,1.2').split(',').map(Number);
const READ_MS = 250;

/** One leaf draw (a set of the main view) with its prepass and its second pass. */
interface Passes {
  plain: THREE.Mesh;
  pre: THREE.Mesh;
  after: THREE.Mesh;
}

export class LeafPrepass {
  /** Always on, always off or by the leaves' density (the default, `?leafpre=`). */
  mode: 'auto' | boolean = MODE === 'auto' ? 'auto' : MODE === '1';
  /** Drawn this frame. */
  on = false;
  private shown: boolean | null = null; // (the meshes' state: null, all visible for the precompile)
  /** Hardware leaf triangles per scene pixel, last read back. */
  density = 0;
  private readonly passes: Passes[] = [];
  private lastRead = -Infinity;
  private reading = false;

  private readonly nanite: NaniteRenderer;

  constructor(nanite: NaniteRenderer) {
    this.nanite = nanite;
  }

  /**
   * The prepass and second pass of `plain`, the main view's leaf mesh of `set`, on its layers. All three are visible
   * until the first update(), so the precompile (the demo's warmup.ts) compiles every pipeline.
   */
  build(view: View, set: CullSet, plain: THREE.Mesh): THREE.Mesh[] {
    const nanite = this.nanite, textures = nanite.textures;
    const list = storage(set.listAttr, 'uvec2', LIST_CAP * 2).toReadOnly();
    const vPre = varying(vec4(0, 0, 0, 1), 'vPre'); // (uv, texture layer, the share drawn as geometry: one location)
    // (the leaf draw's vertex, draw.ts: the same nodes, so the same depth)
    const position = Fn(() => {
      const entry = list.element(instanceIndex.add(LIST_CAP));
      const inst = entry.x, c = entry.y;
      const m = nanite._meta(c);
      const vx = nanite._vertex(inst, c, uint(0), true, nanite.idx.element(m.x).add(minU(vertexIndex, m.y.mul(2).sub(1))));
      vPre.assign(vec4(vx.uv, textures.leafLayerOf(vx.type), nanite._geometryShare(inst, view)));
      return select(vertexIndex.div(2).lessThan(m.y), vx.world, vec3(0));
    })();
    const vUv = vPre.xy, vLayer = vPre.z, vFade = vPre.w;
    const leafAlpha = makeLeafAlpha(textures.leaf, vUv);
    const layer = vLayer.round();
    const a = texture(textures.leaf, vUv).depth(layer).bias(mipBias).a;
    const alpha = textures.leafDither ? a2cDither(leafAlpha(a, layer)) : leafAlpha(a, layer);
    const preMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
    preMat.alphaToCoverage = textures.alphaToCoverage;
    preMat.colorWrite = false;
    // (no lights or fog: else the vertex shader passes a normal and positions to a lighting nobody sees)
    preMat.lights = false;
    preMat.fog = false;
    preMat.colorNode = vec4(1, 1, 1, select(dither().lessThan(vFade), alpha, float(0)));
    preMat.positionNode = position;
    const pre = new THREE.Mesh(plain.geometry, preMat);
    pre.frustumCulled = false;
    pre.layers.mask = plain.layers.mask;
    pre.name = `${plain.name}-pre`;
    pre.renderOrder = -1; // (before every other opaque draw)
    // (its own material: cloned, a NodeMaterial lost its alphaTest and more, darker leaves)
    const after = nanite._buildMesh(1, view, set, false, true);
    after.layers.mask = plain.layers.mask;
    after.name = `${plain.name}-after`;
    this.passes.push({ plain, pre, after });
    return [pre, after];
  }

  /** Picks the passes for this frame (`pixels`: the scene's); in `auto`, reads the leaf counters back now and then. */
  update(pixels: number): void {
    if (this.mode === 'auto' && !this.reading && performance.now() - this.lastRead > READ_MS) {
      this.lastRead = performance.now();
      this.reading = true;
      this.leafTris().then((tris) => {
        this.density = tris / Math.max(pixels, 1);
        this.reading = false;
      }, () => (this.reading = false));
    }
    const on = this.mode === 'auto' ? this.density > (this.on ? PREPASS_OFF : PREPASS_ON) : this.mode;
    if (on === this.shown) return; // (only on a change: the harness's cost probe switches the meshes itself)
    this.on = this.shown = on;
    for (const p of this.passes) {
      p.plain.visible = !on;
      p.pre.visible = p.after.visible = on;
    }
  }

  /** The main view's hardware leaf triangles (both phases), read back. */
  private async leafTris(): Promise<number> {
    const view = this.nanite.main;
    if (!view.ran) return 0;
    const ctr = new Uint32Array(await this.nanite.renderer.getArrayBufferAsync(view.ctr.attr));
    return view.sets.reduce((n, set, k) => n + (k === 0 || set.ran ? ctr[set.base + STATS + 1] : 0), 0);
  }
}
