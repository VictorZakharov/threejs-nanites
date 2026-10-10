// NaniteForest methods: the culling passes (per view: instances -> work items -> clusters -> draw lists).
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, storage, uniform, uniformArray, instanceIndex, workgroupId, localId, numWorkgroups, uint, vec3,
  vec4, uvec2, atomicAdd, atomicStore, select, max, min, length, dot,
} from 'three/tsl';
import { curve } from '../planet.ts';
import { switchPx } from './shading.ts';
import { FADE_HI, MAX_TRIS, WG, MAX_ITEMS, MAX_DIM, LIST_CAP, IMP_BIT, rotY, windMargin } from './constants.ts';

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
  /** occ: null (no occlusion), 'retest' (phase 1: failures go to the retest list), 'final' (phase 2) */
  _buildSet(v, tau, occ) {
    const sb = (arr, item) => new THREE.StorageBufferAttribute(arr, item);
    const u = this.u;
    const set = {
      itemsAttr: sb(new Uint32Array(MAX_ITEMS * 2), 2),
      dispatchAttr: new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4),
      barkArgsAttr: new THREE.IndirectStorageBufferAttribute(new Uint32Array([MAX_TRIS * 3, 0, 0, 0]), 4),
      leafArgsAttr: new THREE.IndirectStorageBufferAttribute(new Uint32Array([MAX_TRIS * 3, 0, 0, 0]), 4),
      statsAttr: sb(new Uint32Array(5), 1), // bark tris, leaf tris, trees, occluded trees, occluded impostors
      itemCountAttr: sb(new Uint32Array(1), 1),
      barkListAttr: sb(new Uint32Array(LIST_CAP * 2), 2),
      leafListAttr: sb(new Uint32Array(LIST_CAP * 2), 2),
    };
    const items = storage(set.itemsAttr, 'uvec2', MAX_ITEMS);
    const dispatchA = storage(set.dispatchAttr, 'uint', 4).toAtomic();
    const barkA = storage(set.barkArgsAttr, 'uint', 4).toAtomic();
    const leafA = storage(set.leafArgsAttr, 'uint', 4).toAtomic();
    set.statsA = storage(set.statsAttr, 'uint', 5).toAtomic();
    const barkList = storage(set.barkListAttr, 'uvec2', LIST_CAP);
    const leafList = storage(set.leafListAttr, 'uvec2', LIST_CAP);

    /**
     * Appends cluster c of tree inst to the bark or leaf draw list; in the main view a cluster that's tiny on screen
     * (centre cw, radius rad) goes to the software rasterizer's list instead.
     */
    set.append = (inst, c, cw, rad) => {
      const tris = this.cMeta.element(c).y;
      const isBark = this.cData.element(c.mul(4).add(3)).w.lessThan(0.5);
      const hwAppend = (chain) =>
        chain(isBark, () => {
          const slot = atomicAdd(barkA.element(1), uint(1)).toVar();
          atomicAdd(set.statsA.element(0), tris);
          If(slot.lessThan(LIST_CAP), () => barkList.element(slot).assign(uvec2(inst, c)));
        }).Else(() => {
          const slot = atomicAdd(leafA.element(1), uint(1)).toVar();
          atomicAdd(set.statsA.element(1), tris);
          If(slot.lessThan(LIST_CAP), () => leafList.element(slot).assign(uvec2(inst, c)));
        });
      if (occ) {
        const sw = If(this.sw.wants(cw, rad, tris), () => this.sw.append(inst, c, tris));
        hwAppend((cond, fn) => sw.ElseIf(cond, fn));
      } else hwAppend(If);
    };

    set.reset = Fn(() => {
      atomicStore(dispatchA.element(0), uint(0));
      atomicStore(barkA.element(1), uint(0));
      atomicStore(leafA.element(1), uint(0));
      for (let i = 0; i < 5; i++) atomicStore(set.statsA.element(i), uint(0));
    })().compute(1, [1]);

    /** Emits the work items for tree i (called from an instance pass). */
    set.emit = (i, ti, s, dCam, r) => {
      // clusters whose parent error (local units) is below this can never be selected for this tree
      const thr = tau.mul(max(dCam.sub(r), 0.05)).div(u.projScale.mul(s));
      const start = uint(ti.x);
      const lo = uint(0).toVar(), hi = uint(ti.y).toVar();
      Loop(14, () => {
        If(lo.lessThan(hi), () => {
          const mid = lo.add(hi).div(2).toVar();
          If(this.cData.element(start.add(mid).mul(4).add(3)).y.greaterThan(thr), () => lo.assign(mid.add(1))).Else(() => hi.assign(mid));
        });
      });
      const n = lo;
      const nItems = n.add(WG - 1).div(WG).toVar();
      const base = atomicAdd(dispatchA.element(0), nItems).toVar();
      atomicAdd(set.statsA.element(2), uint(1));
      Loop({ start: uint(0), end: nItems, type: 'uint', condition: '<' }, ({ i: k }) => {
        If(base.add(k).lessThan(MAX_ITEMS), () => {
          items.element(base.add(k)).assign(uvec2(i, k.mul(WG).bitOr(n.shiftLeft(16))));
        });
      });
    };

    // turn the item count into a 2D dispatch; the cluster pass gets the count from a separate buffer (a buffer can't
    // be both the indirect args and a storage binding of the same dispatch)
    const dispatchRW = storage(set.dispatchAttr, 'uint', 4);
    const itemCountW = storage(set.itemCountAttr, 'uint', 1);
    set.clampDispatch = Fn(() => {
      const total = min(dispatchRW.element(0), uint(MAX_ITEMS)).toVar();
      itemCountW.element(0).assign(total);
      dispatchRW.element(0).assign(min(total, uint(MAX_DIM)));
      dispatchRW.element(1).assign(total.add(MAX_DIM - 1).div(MAX_DIM));
    })().compute(1, [1]);

    const itemCount = storage(set.itemCountAttr, 'uint', 1).toReadOnly();
    set.clusters = Fn(() => {
      const itemIdx = workgroupId.x.add(workgroupId.y.mul(numWorkgroups.x));
      const item = items.element(min(itemIdx, uint(MAX_ITEMS - 1)));
      const inst = item.x;
      const local = item.y.bitAnd(0xffff).add(localId.x);
      const n = item.y.shiftRight(16);
      If(local.lessThan(n).and(itemIdx.lessThan(itemCount.element(0))), () => {
        const a = this.instA.element(inst);
        const b = this.instB.element(inst);
        const ti = this.typeInfo.element(uint(b.z));
        const c = uint(ti.x).add(local).toVar();
        const s = a.w;
        const lod = this.cData.element(c.mul(4)), par = this.cData.element(c.mul(4).add(1));
        const cs = this.cData.element(c.mul(4).add(2)), e = this.cData.element(c.mul(4).add(3));
        const projErr = (sph, err) => {
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
              If(this._hzbOccluded(cw, cs.w.mul(s).add(windMargin(ti.w.mul(s)))), () => {
                keep.assign(false);
                if (occ === 'retest') v.retestCluster(inst, c);
              });
            });
          }
          If(keep, () => set.append(inst, c, cw, cs.w.mul(s)));
        });
      });
    })().compute(MAX_ITEMS * WG, [WG]);

    const barkRW = storage(set.barkArgsAttr, 'uint', 4);
    const leafRW = storage(set.leafArgsAttr, 'uint', 4);
    set.clampDraw = Fn(() => {
      barkRW.element(1).assign(min(barkRW.element(1), uint(LIST_CAP)));
      leafRW.element(1).assign(min(leafRW.element(1), uint(LIST_CAP)));
    })().compute(1, [1]);
    return set;
  },

  _buildView(name, tauMul) {
    const u = this.u;
    const main = name === 'main';
    const sb = (arr, item) => new THREE.StorageBufferAttribute(arr, item);
    const v = {
      name,
      planes: uniformArray(Array.from({ length: 6 }, () => new THREE.Vector4()), 'vec4'),
      tauMul: uniform(tauMul),
      lodPos: uniform(new THREE.Vector3()), // where LOD is measured from: the camera (+ a debug shift)
      lodShift: new THREE.Vector3(),
      // per tree: drawn as an impostor this frame? (a flag per tree instead of an appended list: 900k threads
      // appending through one atomic counter took ~5 ms; the impostor draw covers every tree and the vertex shader
      // collapses the unflagged ones, which is far cheaper)
      // (the shadow view's: trees that cast their impostor's shadow, see buildImpostorShadowMesh)
      impFlagAttr: sb(new Uint32Array(this.instanceCount), 1),
    };
    const tau = u.tau.mul(v.tauMul);
    const impFlag = storage(v.impFlagAttr, 'uint', this.instanceCount);
    v.sphereVisible = (c, r) => {
      const ok = uint(1).toVar();
      for (let p = 0; p < 6; p++) {
        const pl = v.planes.element(p);
        If(dot(pl.xyz, c).add(pl.w).lessThan(r.negate()), () => ok.assign(0));
      }
      return ok.equal(1);
    };

    if (main) {
      // phase 1 failures: trees and clusters to test again in phase 2
      const n = this.instanceCount;
      v.retestTreesAttr = sb(new Uint32Array(n), 1);
      v.retestClustersAttr = sb(new Uint32Array(LIST_CAP * 2), 2);
      v.retestCountAttr = sb(new Uint32Array(4), 1); // trees, clusters (appended), trees, clusters (clamped)
      v.retestTreeDispatch = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4);
      v.retestClusterDispatch = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1, 0]), 4);
      const retestTrees = storage(v.retestTreesAttr, 'uint', n);
      const retestClusters = storage(v.retestClustersAttr, 'uvec2', LIST_CAP);
      const countA = storage(v.retestCountAttr, 'uint', 4).toAtomic();
      v.retestTree = (i) => {
        const slot = atomicAdd(countA.element(0), uint(1)).toVar();
        If(slot.lessThan(n), () => retestTrees.element(slot).assign(i)); // (a tree can be listed twice, see IMP_BIT)
      };
      v.retestCluster = (inst, c) => {
        const slot = atomicAdd(countA.element(1), uint(1)).toVar();
        If(slot.lessThan(LIST_CAP), () => retestClusters.element(slot).assign(uvec2(inst, c)));
      };
      v.resetRetest = Fn(() => {
        atomicStore(countA.element(0), uint(0));
        atomicStore(countA.element(1), uint(0));
      })().compute(1, [1]);
      // indirect dispatch sizes of the two retest passes (64 threads per workgroup), and the counts they read
      const countRW = storage(v.retestCountAttr, 'uint', 4);
      const dT = storage(v.retestTreeDispatch, 'uint', 4), dC = storage(v.retestClusterDispatch, 'uint', 4);
      v.retestArgs = Fn(() => {
        const nc = min(countRW.element(1), uint(LIST_CAP)).toVar();
        countRW.element(2).assign(min(countRW.element(0), uint(n)));
        countRW.element(3).assign(nc);
        dT.element(0).assign(countRW.element(0).add(WG - 1).div(WG));
        dC.element(0).assign(nc.add(WG - 1).div(WG));
      })().compute(1, [1]);
      v.retestCounts = storage(v.retestCountAttr, 'uint', 4).toReadOnly();
      v.retestTreesRO = storage(v.retestTreesAttr, 'uint', n).toReadOnly();
      v.retestClustersRO = storage(v.retestClustersAttr, 'uvec2', LIST_CAP).toReadOnly();
    }
    v.sets = [this._buildSet(v, tau, main ? 'retest' : null)];
    if (main) v.sets.push(this._buildSet(v, tau, 'final'));

    /** The per-tree basics shared by the instance passes. */
    const treeInfo = (i) => {
      const a = this.instA.element(i);
      const b = this.instB.element(i);
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
    const setA = v.sets[0];
    v.instances = Fn(() => {
      const i = instanceIndex;
      const { ti, s, centerC, r, dCam, px, visible } = treeInfo(i);
      // between 1 x and FADE_HI x the impostor threshold a tree is drawn both ways, dithered (see dither)
      const swPx = switchPx(u, i).toVar(); // (each tree its own, see switchPx)
      const far = px.lessThan(swPx);
      if (!main) impFlag.element(i).assign(select(visible.and(far), uint(1), uint(0))); // (impostor shadow casters)
      if (main) {
        // impostors are drawn in phase 2 and tested once, against this frame's HZB (retestTreesPass)
        const imp = visible.and(px.lessThan(swPx.mul(FADE_HI))).toVar();
        impFlag.element(i).assign(select(imp, uint(1), uint(0)));
        If(imp.and(u.occlusion.equal(1)), () => v.retestTree(i.bitOr(IMP_BIT)));
      }
      If(visible.and(far.not()), () => {
        if (main) {
          If(u.occlusion.equal(1).and(this._hzbOccluded(centerC, r.add(windMargin(ti.w.mul(s))))), () => v.retestTree(i)).Else(() => setA.emit(i, ti, s, dCam, r));
        } else {
          setA.emit(i, ti, s, dCam, r);
        }
      });
    })().compute(this.instanceCount, [WG]);

    if (main) {
      const setB = v.sets[1];
      // phase 2: trees that failed phase 1, against the new HZB
      v.retestTreesPass = Fn(() => {
        const k = instanceIndex;
        If(k.lessThan(v.retestCounts.element(2)), () => {
          const e = v.retestTreesRO.element(k);
          const i = e.bitAnd(IMP_BIT - 1);
          const { ti, s, centerC, r, dCam } = treeInfo(i);
          const hidden = this._hzbOccluded(centerC, r.add(windMargin(ti.w.mul(s))));
          If(e.greaterThanEqual(IMP_BIT), () => {
            // an impostor: drop it if hidden
            If(hidden, () => {
              impFlag.element(i).assign(0);
              atomicAdd(setB.statsA.element(4), uint(1));
            });
          })
            .ElseIf(hidden, () => {
              atomicAdd(setB.statsA.element(3), uint(1));
            })
            .Else(() => setB.emit(i, ti, s, dCam, r));
        });
      })().compute(this.instanceCount, [WG]);
      // ... and the clusters that failed phase 1 (of trees that passed)
      v.retestClustersPass = Fn(() => {
        const k = instanceIndex;
        If(k.lessThan(v.retestCounts.element(3)), () => {
          const e = v.retestClustersRO.element(k);
          const inst = e.x, c = e.y;
          const a = this.instA.element(inst), b = this.instB.element(inst);
          const ti = this.typeInfo.element(uint(b.z));
          const s = a.w;
          const cs = this.cData.element(c.mul(4).add(2));
          const cw = curve(a.xyz.add(rotY(cs.xyz, b.x, b.y).mul(s))).toVar();
          If(this._hzbOccluded(cw, cs.w.mul(s).add(windMargin(ti.w.mul(s)))).not(), () => setB.append(inst, c, cw, cs.w.mul(s)));
        });
      })().compute(LIST_CAP, [WG]);
    }
    return v;
  },
};
