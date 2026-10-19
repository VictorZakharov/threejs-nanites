// NaniteForest methods: the culling passes (per view: instances -> work items -> clusters -> draw lists).
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, storage, uniform, uniformArray, instanceIndex, workgroupId, localId, numWorkgroups, uint, vec3,
  uvec2, atomicAdd, atomicStore, atomicLoad, select, max, min, length, dot,
} from 'three/tsl';
import { curve } from '../planet.ts';
import { switchPx } from './shading.ts';
import { CHUNK, CHUNK_SHIFT } from './chunks.ts';
import {
  FADE_HI, WG, MAX_ITEMS, minU, MAX_DIM, LIST_CAP, IMP_BIT, IMP_ARGS, SPLAT, rotY, windMargin, makeCounters, SET_STRIDE, ARGS, STATS, ITEM_COUNT, RETEST,
} from './constants.ts';
import type { NaniteForest } from './forest.ts';
import type { Float, Uint, Vec3, Vec4 } from '../types.ts';
import type { CullSet, Retest, TypeInfo, View, ViewBase } from './types.ts';

/** occlusion mode of a set: none (the shadow view), phase 1 (failures go to the retest list), phase 2 */
type Occ = null | 'retest' | 'final';

export const cullingMethods = {
  // ------------------------------------------------------------------ culling (one set of passes per view)
  //
  // A "set" is one cull -> draw chain: work items, the indirect cluster dispatch, bark/leaf cluster lists and their
  // indirect draw args. The shadow view has one set. The main view has two, for Nanite-style two-phase occlusion
  // culling against a max-depth pyramid (HZB):
  //   phase 1 (set A)  trees and clusters are tested against *last* frame's HZB (with last frame's camera); what
  //                    passes is drawn (with terrain, sky and impostors), what fails goes on a retest list
  //   HZB              rebuilt from this frame's phase 1 depth
  //   phase 2 (set B)  the retest lists are tested again against the new HZB and what's visible is drawn too.
  // Everything visible is drawn in the frame it becomes visible (no one-frame holes when the camera moves), and the
  // test is per cluster: the trunk and lower crown behind the canopy, the far side of a tree, are skipped too.
  /**
   * occ: null (no occlusion), 'retest' (phase 1: failures go to the retest list), 'final' (phase 2); k: the set's
   * index in the view (its slice of the view's counters).
   */
  _buildSet(this: NaniteForest, v: ViewBase, tau: Float, occ: Occ, k: number): CullSet {
    const sb = (arr: Uint32Array, item: number) => new THREE.StorageBufferAttribute(arr, item);
    const u = this.u;
    const base = k * SET_STRIDE;
    const itemsAttr = sb(new Uint32Array(MAX_ITEMS * 2), 2);
    const dispatchAttr = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4);
    const listAttr = sb(new Uint32Array(LIST_CAP * 4), 2); // the bark list, then the leaf list
    const items = storage(itemsAttr, 'uvec2', MAX_ITEMS);
    const dispatchA = storage(dispatchAttr, 'uint', 4).toAtomic();
    const ctrA = v.ctr.atomic;
    const barkCount = ctrA.element(base + ARGS.bark + 1), leafCount = ctrA.element(base + ARGS.leaf + 1);
    const stat = (i: number) => ctrA.element(base + STATS + i);
    const list = storage(listAttr, 'uvec2', LIST_CAP * 2);

    /**
     * Appends cluster c of tree inst to the bark or leaf draw list; in the main view a cluster that's tiny on screen
     * (centre cw, radius rad) goes to the software rasterizer's list instead.
     */
    const append = (inst: Uint, c: Uint, cw: Vec3, rad: Float): void => {
      const tris = this._meta(c).y;
      const isBark = this._cd(c, 3).w.lessThan(0.5);
      const toBark = (): void => {
        const slot = atomicAdd(barkCount, uint(1)).toVar();
        atomicAdd(stat(0), tris);
        If(slot.lessThan(LIST_CAP), () => list.element(slot).assign(uvec2(inst, c)));
      };
      const toLeaves = (): void => {
        const slot = atomicAdd(leafCount, uint(1)).toVar();
        atomicAdd(stat(1), tris);
        If(slot.lessThan(LIST_CAP), () => list.element(slot.add(LIST_CAP)).assign(uvec2(inst, c)));
      };
      if (occ) If(this.sw.wants(cw, rad, tris), () => this.sw.append(inst, c, tris)).ElseIf(isBark, toBark).Else(toLeaves);
      else If(isBark, toBark).Else(toLeaves);
    };

    const reset = Fn(() => {
      atomicStore(dispatchA.element(0), uint(0));
      atomicStore(barkCount, uint(0));
      atomicStore(leafCount, uint(0));
      for (let i = 0; i < 5; i++) atomicStore(stat(i), uint(0));
    })().compute(1, [1]);

    /** Emits the work items for tree i (called from an instance pass). */
    const emit = (i: Uint, ti: TypeInfo, s: Float, dCam: Float, r: Float): void => {
      // clusters whose parent error (local units) is below this can never be selected for this tree
      const thr = tau.mul(max(dCam.sub(r), 0.05)).div(u.projScale.mul(s));
      const start = uint(ti.x);
      const lo = uint(0).toVar(), hi = uint(ti.y).toVar();
      Loop(14, () => {
        If(lo.lessThan(hi), () => {
          const mid = lo.add(hi).div(2).toVar();
          If(this._cd(start.add(mid), 3).y.greaterThan(thr), () => lo.assign(mid.add(1))).Else(() => hi.assign(mid));
        });
      });
      const n = lo;
      const nItems = n.add(WG - 1).div(WG).toVar();
      const first = atomicAdd(dispatchA.element(0), nItems).toVar();
      atomicAdd(stat(2), uint(1));
      Loop({ start: uint(0), end: nItems, type: 'uint', condition: '<' }, ({ i: k }: { i: Uint }) => {
        If(first.add(k).lessThan(MAX_ITEMS), () => {
          items.element(first.add(k)).assign(uvec2(i, k.mul(WG).bitOr(n.shiftLeft(16))));
        });
      });
    };

    // turn the item count into a 2D dispatch; the cluster pass gets the count from the counters (a buffer can't be
    // both the indirect args and a storage binding of the same dispatch)
    const dispatchRW = storage(dispatchAttr, 'uint', 4);
    const clampDispatch = Fn(() => {
      const total = minU(dispatchRW.element(0), MAX_ITEMS).toVar();
      v.ctr.rw.element(base + ITEM_COUNT).assign(total);
      dispatchRW.element(0).assign(minU(total, MAX_DIM));
      dispatchRW.element(1).assign(total.add(MAX_DIM - 1).div(MAX_DIM));
    })().compute(1, [1]);

    const clusters = Fn(() => {
      const itemIdx = workgroupId.x.add(workgroupId.y.mul(numWorkgroups.x));
      const item = items.element(minU(itemIdx, MAX_ITEMS - 1));
      const inst = item.x;
      const local = item.y.bitAnd(0xffff).add(localId.x);
      const n = item.y.shiftRight(16);
      If(local.lessThan(n).and(itemIdx.lessThan(atomicLoad(ctrA.element(base + ITEM_COUNT)))), () => {
        const a = this._a(inst);
        const b = this._b(inst);
        const ti = this.typeInfo.element(uint(b.z));
        const c = uint(ti.x).add(local).toVar();
        const s = a.w;
        const lod = this._cd(c, 0), par = this._cd(c, 1);
        const cs = this._cd(c, 2), e = this._cd(c, 3);
        const projErr = (sph: Vec4, err: Float): Float => {
          const w = a.xyz.add(rotY(sph.xyz, b.x, b.y).mul(s));
          const dist = max(length(w.sub(v.lodPos)).sub(sph.w.mul(s)), 0.05);
          return err.mul(s).mul(u.projScale).div(dist);
        };
        // DAG cut: fine enough itself, but the parent group is too coarse
        const cut = projErr(lod, e.x).lessThanEqual(tau).and(projErr(par, e.y).greaterThan(tau));
        If(cut, () => {
          const cw = curve(a.xyz.add(rotY(cs.xyz, b.x, b.y).mul(s))).toVar();
          const keep = v.sphereVisible(cw, cs.w.mul(s)).toVar();
          if (occ) {
            If(keep.and(u.occlusion.equal(1)), () => {
              If(this._hzbOccluded(cw, cs.w.mul(s).add(windMargin(ti.w, cs.y.add(cs.w), s, this._sway(b.z)))), () => {
                keep.assign(false);
                if (occ === 'retest') v.retest?.cluster(inst, c);
              });
            });
          }
          If(keep, () => append(inst, c, cw, cs.w.mul(s)));
        });
      });
    })().compute(MAX_ITEMS * WG, [WG]);

    const ctrRW = v.ctr.rw;
    const clampDraw = Fn(() => {
      for (const k of [ARGS.bark, ARGS.leaf]) ctrRW.element(base + k + 1).assign(minU(ctrRW.element(base + k + 1), LIST_CAP));
    })().compute(1, [1]);
    return { base, itemsAttr, dispatchAttr, listAttr, ctr: v.ctr, stat, append, emit, reset, clampDispatch, clusters, clampDraw };
  },

  /** The main view's occlusion retest lists (phase 1 failures, tested again in phase 2) and their small passes. */
  _buildRetest(this: NaniteForest, ctr: ViewBase['ctr']): Retest {
    const sb = (arr: Uint32Array, item: number) => new THREE.StorageBufferAttribute(arr, item);
    const n = this.instanceCount;
    const ctrA = ctr.atomic;
    const treesAttr = sb(new Uint32Array(n), 1);
    const clustersAttr = sb(new Uint32Array(LIST_CAP * 2), 2);
    const treeDispatch = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4);
    const clusterDispatch = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4);
    const trees = storage(treesAttr, 'uint', n);
    const clusters = storage(clustersAttr, 'uvec2', LIST_CAP);
    // indirect dispatch sizes of the two retest passes (64 threads per workgroup), and the counts they read
    const count = (i: number) => ctr.rw.element(RETEST + i);
    const dT = storage(treeDispatch, 'uint', 4), dC = storage(clusterDispatch, 'uint', 4);
    return {
      treesAttr, clustersAttr, treeDispatch, clusterDispatch,
      tree: (i) => {
        const slot = atomicAdd(ctrA.element(RETEST), uint(1)).toVar();
        If(slot.lessThan(n), () => trees.element(slot).assign(i)); // (a tree can be listed twice, see IMP_BIT)
      },
      cluster: (inst, c) => {
        const slot = atomicAdd(ctrA.element(RETEST + 1), uint(1)).toVar();
        If(slot.lessThan(LIST_CAP), () => clusters.element(slot).assign(uvec2(inst, c)));
      },
      reset: Fn(() => {
        atomicStore(ctrA.element(RETEST), uint(0));
        atomicStore(ctrA.element(RETEST + 1), uint(0));
      })().compute(1, [1]),
      args: Fn(() => {
        const nc = minU(count(1), LIST_CAP).toVar();
        count(2).assign(minU(count(0), n));
        count(3).assign(nc);
        dT.element(0).assign(count(0).add(WG - 1).div(WG));
        dC.element(0).assign(nc.add(WG - 1).div(WG));
      })().compute(1, [1]),
      count: (i) => atomicLoad(ctrA.element(RETEST + i)), // (the passes that read it also add to the counters)
      treesRO: storage(treesAttr, 'uint', n).toReadOnly(),
      clustersRO: storage(clustersAttr, 'uvec2', LIST_CAP).toReadOnly(),
    };
  },

  _buildView(this: NaniteForest, name: string, tauMul: number): View {
    const u = this.u;
    const main = name === 'main';
    const planeValues = Array.from({ length: 6 }, () => new THREE.Vector4());
    const planes = uniformArray<'vec4'>(planeValues, 'vec4');
    const chunkValues = Array.from({ length: Math.ceil(this.chunks.count / 2) }, () => new THREE.Vector4());
    const ctr = main ? this.mainCtr : makeCounters(); // (the main view's is shared with the software rasterizer)
    const v: ViewBase = {
      name,
      planeValues,
      planes,
      tauMul: uniform(tauMul),
      lodPos: uniform(new THREE.Vector3()), // where LOD is measured from: the camera (+ a debug shift)
      lodShift: new THREE.Vector3(),
      // the trees drawn as impostors this frame, appended; the impostor draw has one instance per entry (its count
      // in the counters, IMP_ARGS). It was a flag per tree with a draw over every tree that collapsed the unflagged
      // ones: 2.5M instances x 6 vertices, for the view and the shadow map, whatever the quality (a fixed cost the
      // auto quality couldn't touch: a Mac at 4 fps). The main view lists only what passes phase 2's occlusion
      // test (~2k at ground level, of ~240k in view).
      // (the shadow view's: trees that cast their impostor's shadow, see buildImpostorShadowMesh)
      impListAttr: new THREE.StorageBufferAttribute(new Uint32Array(this.instanceCount), 1),
      chunkValues,
      chunkList: uniformArray<'vec4'>(chunkValues, 'vec4'),
      impRetest: uniform(0, 'uint'),
      ctr,
      sphereVisible: (c, r) => {
        const ok = uint(1).toVar();
        for (let p = 0; p < 6; p++) {
          const pl = planes.element(p);
          If(dot(pl.xyz, c).add(pl.w).lessThan(r.negate()), () => ok.assign(0));
        }
        // the shadow view: and its shadow can land in the camera's view (the sphere swept castLen away from the sun
        // touches the camera's frustum; see CastTest in chunks.ts), for trees and clusters alike
        if (!main) {
          const mp = this.main.planes;
          for (let p = 0; p < 6; p++) {
            const pl = mp.element(p);
            const d = dot(pl.xyz, c).add(pl.w);
            const d1 = d.sub(u.castLen.mul(dot(pl.xyz, u.sunDir)));
            If(u.castLen.greaterThan(0).and(max(d, d1).lessThan(r.negate())), () => ok.assign(0));
          }
        }
        return ok.equal(1);
      },
      // phase 1 failures: trees and clusters to test again in phase 2
      retest: main ? this._buildRetest(ctr) : null,
    };
    const tau = u.tau.mul(v.tauMul);
    const impList = storage(v.impListAttr, 'uint', this.instanceCount);
    const impCount = ctr.atomic.element(IMP_ARGS + 1);
    // (a tree is listed once at most: by the instance pass, or by phase 2 when it tests the impostors)
    // in the main view, tiny ones (`px` tall, switching at `swPx`) are splatted instead: listed from the top down
    // (see splats.ts)
    const n = this.instanceCount;
    const splatCount = ctr.atomic.element(SPLAT);
    const impAppend = (i: Uint, px?: Float, swPx?: Float): void => {
      const draw = (): void => {
        impList.element(atomicAdd(impCount, uint(1))).assign(i);
      };
      if (main && px && swPx) {
        If(this.splats.wants(i, px, swPx), () => {
          impList.element(uint(n - 1).sub(atomicAdd(splatCount, uint(1)))).assign(i);
        }).Else(draw);
      } else draw();
    };
    const impReset = Fn(() => {
      atomicStore(impCount, uint(0));
      atomicStore(splatCount, uint(0));
    })().compute(1, [1]);
    const sets = [this._buildSet(v, tau, main ? 'retest' : null, 0)];
    if (main) sets.push(this._buildSet(v, tau, 'final', 1));

    /** The per-tree basics shared by the instance passes. */
    const treeInfo = (i: Uint) => {
      const a = this._a(i);
      const b = this._b(i);
      const ti = this.typeInfo.element(uint(b.z));
      const s = a.w;
      const center = a.xyz.add(vec3(0, ti.w.mul(0.5).mul(s), 0));
      const centerC = curve(center).toVar(); // where the planet's curvature puts it on screen
      const r = ti.z.mul(s);
      const dCam = length(center.sub(v.lodPos)).toVar();
      const px = ti.w.mul(s).mul(u.projScale).div(max(dCam, 0.1)); // projected tree height
      const visible = v.sphereVisible(centerC, r).and(dCam.sub(r).lessThan(u.maxDist)).toVar();
      return { ti, s, centerC, r, dCam, px, visible };
    };

    // phase 1 (and the only pass of the shadow view)
    const setA = sets[0];
    const instances = Fn(() => {
      // thread k: slot k % CHUNK of the (k / CHUNK)-th chunk in view (see chunks.ts)
      const k = instanceIndex.shiftRight(CHUNK_SHIFT);
      const pair = v.chunkList.element(k.shiftRight(1)), odd = k.bitAnd(1).equal(1);
      const first = uint(select(odd, pair.z, pair.x)), count = uint(select(odd, pair.w, pair.y));
      const slot = instanceIndex.bitAnd(CHUNK - 1);
      If(slot.lessThan(count), () => {
        const i = first.add(slot).toVar();
        const { ti, s, centerC, r, dCam, px, visible } = treeInfo(i);
        // between 1 x and FADE_HI x the impostor threshold a tree is drawn both ways, dithered (see dither)
        const swPx = switchPx(u, i).toVar(); // (each tree its own, see switchPx)
        const far = px.lessThan(swPx);
        const retest = v.retest;
        if (!retest) If(visible.and(far), () => impAppend(i)); // (impostor shadow casters)
        else {
          // impostors are drawn in phase 2 and tested once, against this frame's HZB (retestTreesPass); listed here when
          // phase 2 won't run (occlusion off, no HZB yet)
          If(visible.and(px.lessThan(swPx.mul(FADE_HI))).and(this._impostorKept(i)), () => {
            If(v.impRetest.equal(1), () => retest.tree(i.bitOr(IMP_BIT))).Else(() => impAppend(i, px, swPx));
          });
        }
        If(visible.and(far.not()), () => {
          if (retest) {
            If(u.occlusion.equal(1).and(this._hzbOccluded(centerC, r.add(windMargin(ti.w, ti.w, s, this._sway(this._b(i).z))))), () => retest.tree(i)).Else(() => setA.emit(i, ti, s, dCam, r));
          } else {
            setA.emit(i, ti, s, dCam, r);
          }
        });
      });
    })().compute(this.chunks.count * CHUNK, [WG]).setName(`${name} instances`);

    const retest = v.retest;
    if (retest) {
      const setB = sets[1];
      // phase 2: trees that failed phase 1, against the new HZB
      retest.treesPass = Fn(() => {
        const k = instanceIndex;
        If(k.lessThan(retest.count(2)), () => {
          const e = retest.treesRO.element(k);
          const i = e.bitAnd(IMP_BIT - 1);
          const { ti, s, centerC, r, dCam, px } = treeInfo(i);
          const hidden = this._hzbOccluded(centerC, r.add(windMargin(ti.w, ti.w, s, this._sway(this._b(i).z))));
          If(e.greaterThanEqual(IMP_BIT), () => {
            // an impostor: listed if it's not hidden
            If(hidden, () => {
              atomicAdd(setB.stat(4), uint(1));
            }).Else(() => impAppend(i, px, switchPx(u, i)));
          })
            .ElseIf(hidden, () => {
              atomicAdd(setB.stat(3), uint(1));
            })
            .Else(() => setB.emit(i, ti, s, dCam, r));
        });
      })().compute(this.instanceCount, [WG]).setName('retest trees');
      // ... and the clusters that failed phase 1 (of trees that passed)
      retest.clustersPass = Fn(() => {
        const k = instanceIndex;
        If(k.lessThan(retest.count(3)), () => {
          const e = retest.clustersRO.element(k);
          const inst = e.x, c = e.y;
          const a = this._a(inst), b = this._b(inst);
          const ti = this.typeInfo.element(uint(b.z));
          const s = a.w;
          const cs = this._cd(c, 2);
          const cw = curve(a.xyz.add(rotY(cs.xyz, b.x, b.y).mul(s))).toVar();
          If(this._hzbOccluded(cw, cs.w.mul(s).add(windMargin(ti.w, cs.y.add(cs.w), s, this._sway(b.z)))).not(), () => setB.append(inst, c, cw, cs.w.mul(s)));
        });
      })().compute(LIST_CAP, [WG]).setName('retest clusters');
    }
    return { ...v, sets, instances, impReset };
  },
};
