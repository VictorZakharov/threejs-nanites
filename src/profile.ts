// GPU profile (the perf panel's PROFILE button, `demo.profile()`): where a device's GPU time goes, measured on the
// device itself. It holds the current view and quality, switches one feature off at a time, and takes the median of
// the GPU timestamps for each: the drop from the baseline is that feature's cost. The result is appended to the
// panel's copied report (for phones: the user's S25 spent 24 ms drawing 0.17M triangles at 288x521, so the cost
// is somewhere other than the triangles, and each guess cost a round trip).
import type * as THREE from 'three/webgpu';
import type { AutoQuality } from './hud.ts';
import type { NaniteForest } from './nanite/forest.ts';
import type { TAA } from './taa.ts';
import type { GodRays } from './godrays.ts';

export interface ProfileContext {
  auto: AutoQuality;
  forest: NaniteForest;
  taa: TAA;
  rays: GodRays;
  clouds: THREE.Object3D;
  grass: THREE.Object3D;
  terrain: THREE.Object3D[]; // terrain and sky
  shadowsOn(): boolean;
  setShadows(on: boolean): void;
  setScale(s: number): void;
}

interface Step {
  label: string;
  /** Switches the feature off; returns what puts it back (or null when there's nothing to switch here). */
  off(): (() => void) | null;
}

const SKIP = 20; // samples after a switch: pipelines, history and the shadow map settle
const TAKE = 40;

const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

function steps(ctx: ProfileContext): Step[] {
  const { forest, taa, rays, clouds, terrain } = ctx;
  const flag = (get: () => boolean, set: (v: boolean) => void) => () => {
    if (!get()) return null;
    set(false);
    return () => set(true);
  };
  const uflag = (u: { value: number } | undefined) => () => {
    if (!u || u.value === 0) return null;
    const v = u.value;
    u.value = 0;
    return () => (u.value = v);
  };
  return [
    { label: 'shadow map off', off: flag(ctx.shadowsOn, ctx.setShadows) },
    { label: 'TAA off', off: flag(() => taa.enabled, (v) => ((taa.enabled = v), (taa.reset = true))) },
    { label: 'god rays off', off: flag(() => rays.enabled, (v) => (rays.enabled = v)) },
    { label: 'grass off', off: flag(() => ctx.grass.visible, (v) => (ctx.grass.visible = v)) },
    { label: 'clouds off', off: flag(() => clouds.visible, (v) => (clouds.visible = v)) },
    { label: 'occlusion off', off: uflag(forest.u.occlusion) },
    { label: 'sw raster off', off: uflag(forest.u.sw) },
    { label: 'terrain+sky off', off: flag(() => terrain.every((o) => o.visible), (v) => terrain.forEach((o) => (o.visible = v))) },
    { label: 'tree draws off', off: flag(() => forest.group.visible, (v) => (forest.group.visible = v)) },
    {
      label: 'half the pixels',
      off: () => {
        const s = ctx.auto.scale;
        ctx.setScale(s * Math.SQRT1_2);
        return () => ctx.setScale(s);
      },
    },
  ];
}

/** Median render and compute GPU ms over the next TAKE timestamp samples (after SKIP). */
function sample(auto: AutoQuality): Promise<[number, number]> {
  return new Promise((resolve) => {
    const r: number[] = [], c: number[] = [];
    let k = 0;
    auto.onSample = (render, compute) => {
      if (k++ < SKIP) return;
      r.push(render);
      c.push(compute);
      if (r.length < TAKE) return;
      auto.onSample = undefined;
      resolve([median(r), median(c)]);
    };
  });
}

/** Runs the profile; `progress` gets each step's label. Returns the report section. */
export async function runProfile(ctx: ProfileContext, progress: (label: string, i: number, n: number) => void): Promise<string> {
  const auto = ctx.auto, wasAuto = auto.on;
  auto.on = false; // (hold the quality: the controller would answer every switch)
  const all = steps(ctx);
  const f = (v: number): string => v.toFixed(2).padStart(6);
  try {
    progress('baseline', 0, all.length + 1);
    const [r0, c0] = await sample(auto);
    const lines = [
      `gpu profile  median ms of ${TAKE} frames each, same view and quality; "saves" = baseline minus that feature off`,
      `  baseline           render ${f(r0)}  compute ${f(c0)}  total ${f(r0 + c0)}`,
    ];
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      progress(s.label, i + 1, all.length + 1);
      const undo = s.off();
      if (!undo) {
        lines.push(`  ${s.label.padEnd(18)} (already)`);
        continue;
      }
      const [r, c] = await sample(auto);
      undo();
      lines.push(`  ${s.label.padEnd(18)} render ${f(r)}  compute ${f(c)}  saves ${f(r0 + c0 - r - c)}`);
    }
    return lines.join('\n');
  } finally {
    auto.onSample = undefined;
    auto.on = wasAuto;
  }
}
