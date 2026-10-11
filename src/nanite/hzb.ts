// NaniteForest methods: the max-depth pyramid (HZB) and the phase 2 occlusion passes.
import * as THREE from 'three/webgpu';
import {
  Fn, If, storage, uniform, uniformArray, instanceIndex, uint, float, vec4, max, min, clamp, log2, exp2,
  ivec2, int, textureLoad,
} from 'three/tsl';
import type { ComputeNode, StorageBufferNode, UniformArrayNode } from 'three/webgpu';
import { WG, HZB_LEVELS, HZB_LEVEL0_MAX, HZB_FLOATS, minU } from './constants.ts';
import type { NaniteForest } from './forest.ts';
import type { Bool, Float, Uint, Vec3 } from '../types.ts';
import type { U } from './types.ts';

/** The main view's HZB: all levels in one float buffer, their (offset, w, h) and the camera it was built with. */
export interface Hzb {
  buf: StorageBufferNode<'float'>;
  levels: UniformArrayNode<'vec4'>;
  levelValues: THREE.Vector4[];
  count: U<'uint', number>;
  size: U<'vec2', THREE.Vector2>; // depth buffer pixels
  view: U<'mat4', THREE.Matrix4>;
  proj: U<'vec4', THREE.Vector4>; // P00, P11, P22, P32
  near: U<'float', number>;
  passes: ComputeNode[];
  attr: THREE.StorageBufferAttribute;
}

export const hzbMethods = {
  // ------------------------------------------------------------------ HZB (max-depth pyramid of the main view)
  _buildHzb(this: NaniteForest): void {
    // level 0 is half resolution (each texel = 2x2 pixels x all MSAA samples)
    const attr = new THREE.StorageBufferAttribute(new Float32Array(HZB_FLOATS), 1);
    const levelValues = Array.from({ length: HZB_LEVELS }, () => new THREE.Vector4());
    this.hzb = {
      buf: storage(attr, 'float', HZB_FLOATS),
      levels: uniformArray<'vec4'>(levelValues, 'vec4'), // offset, w, h
      levelValues,
      count: uniform(1, 'uint'),
      size: uniform(new THREE.Vector2(1, 1)),
      view: uniform(new THREE.Matrix4()),
      proj: uniform(new THREE.Vector4()),
      near: uniform(0.3),
      passes: [],
      attr,
    };
  },

  /** True if a world-space sphere (planet-curved centre) lies entirely behind the HZB. */
  _hzbOccluded(this: NaniteForest, c: Vec3, r: Float): Bool {
    const h = this.hzb;
    const res = uint(0).toVar();
    const cv = h.view.mul(vec4(c, 1)).xyz.toVar();
    const d = cv.z.negate().toVar();
    const d0 = d.sub(r).toVar();
    If(d0.greaterThan(h.near), () => {
      const d1 = d.add(r);
      // screen rect: the extremes of the sphere's view-space box over its nearest and farthest depth
      const ext = (lo: Float, hi: Float, k: Float): [Float, Float] => {
        const q = [lo.div(d0), lo.div(d1), hi.div(d0), hi.div(d1)];
        return [
          clamp(min(min(q[0], q[1]), min(q[2], q[3])).mul(k), -1, 1),
          clamp(max(max(q[0], q[1]), max(q[2], q[3])).mul(k), -1, 1),
        ];
      };
      const [nx0, nx1] = ext(cv.x.sub(r), cv.x.add(r), h.proj.x);
      const [ny0, ny1] = ext(cv.y.sub(r), cv.y.add(r), h.proj.y);
      const px0 = nx0.mul(0.5).add(0.5).mul(h.size.x), px1 = nx1.mul(0.5).add(0.5).mul(h.size.x);
      const py0 = ny1.mul(-0.5).add(0.5).mul(h.size.y), py1 = ny0.mul(-0.5).add(0.5).mul(h.size.y);
      const size = max(px1.sub(px0), py1.sub(py0));
      // a level where the rect spans at most 4 texels a side (a level L texel is 2^(L+1) pixels), max of those
      // (finer than the usual 2x2: near the horizon a coarse texel takes in sky above the treeline)
      const L = uint(clamp(log2(max(size.div(3), 1)).ceil().sub(1), 0, float(h.count).sub(1))).toVar();
      const lv = h.levels.element(L);
      const scale = exp2(float(L).add(1));
      const off = uint(lv.x), w = uint(lv.y), hh = uint(lv.z);
      const tx = (p: Float, n: Uint): Uint => minU(uint(max(p.div(scale).floor(), 0)), n.sub(1));
      const tx0 = tx(px0, w), tx1 = tx(px1, w), ty0 = tx(py0, hh), ty1 = tx(py1, hh);
      const farthest = float(0).toVar();
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const x = minU(tx0.add(i), tx1), y = minU(ty0.add(j), ty1);
          farthest.assign(max(farthest, h.buf.element(off.add(y.mul(w)).add(x))));
        }
      // depth (0..1) of the sphere's nearest point
      const zNear = h.proj.z.mul(d0.negate()).add(h.proj.w).div(d0);
      If(zNear.greaterThan(farthest), () => res.assign(1));
    });
    return res.equal(1);
  },

  /** The depth buffer the HZB is built from (the main view's render target). */
  setDepthSource(this: NaniteForest, depthTexture: THREE.DepthTexture, samples: number): void {
    const h = this.hzb;
    h.passes = [];
    for (let L = 0; L < HZB_LEVELS; L++) {
      const node = Fn(() => {
        const idx = instanceIndex;
        const lv = h.levels.element(L);
        const w = uint(lv.y), hh = uint(lv.z);
        If(idx.lessThan(w.mul(hh)), () => {
          const x = idx.mod(w), y = idx.div(w);
          const m = float(0).toVar();
          if (L === 0) {
            const W = uint(h.size.x), H = uint(h.size.y);
            for (let dy = 0; dy < 2; dy++)
              for (let dx = 0; dx < 2; dx++) {
                const p = ivec2(int(minU(x.mul(2).add(dx), W.sub(1))), int(minU(y.mul(2).add(dy), H.sub(1))));
                for (let k = 0; k < samples; k++) m.assign(max(m, textureLoad(depthTexture, p, int(k)).x));
              }
          } else {
            const pl = h.levels.element(L - 1);
            const po = uint(pl.x), pw = uint(pl.y), ph = uint(pl.z);
            for (let dy = 0; dy < 2; dy++)
              for (let dx = 0; dx < 2; dx++) {
                const cx = minU(x.mul(2).add(dx), pw.sub(1)), cy = minU(y.mul(2).add(dy), ph.sub(1));
                m.assign(max(m, h.buf.element(po.add(cy.mul(pw)).add(cx))));
              }
          }
          h.buf.element(uint(lv.x).add(y.mul(w)).add(x)).assign(m);
        });
      })().compute(HZB_LEVEL0_MAX, [WG]);
      h.passes.push(node);
    }
    this.hzbReady = true;
  },

  /** Will occlusion() run phase 2 this frame (at this drawing-buffer size)? */
  willOcclude(this: NaniteForest, width: number, height: number): boolean {
    const retest = this.main.retest;
    return !this.frozen && this.hzbReady && this.u.occlusion.value !== 0 && Boolean(retest?.treesPass && retest.clustersPass) &&
      Math.ceil(width / 2) * Math.ceil(height / 2) <= HZB_LEVEL0_MAX; // (a huge screen: phase 1 only)
  },

  /** Phase 2 (main view): build the HZB from the phase 1 depth, then cull set B against it. */
  occlusion(this: NaniteForest, camera: THREE.Camera, width: number, height: number): void {
    const v = this.main, retest = v.retest;
    // (must agree with the instance pass's impRetest: it left the impostors to this pass)
    if (!this.willOcclude(width, height) || !retest?.treesPass || !retest.clustersPass) return;
    const h = this.hzb;
    let w = Math.ceil(width / 2), hh = Math.ceil(height / 2), off = 0, n = 0;
    const counts: number[] = [];
    while (n < HZB_LEVELS) {
      h.levelValues[n].set(off, w, hh, 0);
      counts.push(w * hh);
      off += w * hh;
      n++;
      if (w === 1 && hh === 1) break;
      w = Math.ceil(w / 2);
      hh = Math.ceil(hh / 2);
    }
    h.count.value = n;
    h.size.value.set(width, height);
    h.view.value.copy(camera.matrixWorldInverse);
    const e = camera.projectionMatrix.elements;
    h.proj.value.set(e[0], e[5], e[10], e[14]);
    h.near.value = (camera as THREE.PerspectiveCamera).near;
    const r = this.renderer;
    for (let L = 0; L < n; L++) r.compute(h.passes[L], counts[L]);
    const setB = v.sets[1];
    r.compute(retest.args);
    r.compute(retest.treesPass, retest.treeDispatch);
    r.compute(retest.clustersPass, retest.clusterDispatch);
    r.compute(setB.clampDispatch);
    r.compute(setB.clusters, setB.dispatchAttr);
    r.compute(setB.clampDraw);
    setB.ran = true;
  },
};
