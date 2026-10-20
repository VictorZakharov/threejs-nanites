// --typematch: how well the impostors match the real trees, per tree type. Each view is drawn all geometry (imppx 0)
// and all impostors (imppx huge), each once with debug=4 (a flat colour per tree type: the mask) and once normally
// (the colours). Per type: pixels covered and mean colour in both, and the colour ratio geometry / impostor.
//
// --typematch=calibrate also adjusts the impostor gains in the page (forest.impGains, live uniforms) until the
// colours match, and prints the gains to put into VARIANTS in src/trees.ts. Views looking down steeply (pitch
// <= -60) calibrate the top-down gains, the others the side gains: use d550 for top and fogline for side (distant
// trees only: near trees as geometry get real shadows that impostors can't have).
// --typematch=cover adjusts each type's coverage scale (impCov, the impostor frames' z / w: side / top) until its
// impostors cover as many pixels as its real trees (in the debug=4 masks), and prints them; then calibrate the gains.
// Use views where the forest isn't a solid wall (d550 for top, then slope for side): along the fog line which type
// is in front decides the counts, not the coverage.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWS } from './views.ts';
import { typeMask, typeColours } from './images.ts';
import { at } from './status.ts';
import type { Page } from 'playwright-core';
import type { Vector3 } from 'three';
import type { Options } from './options.ts';

type TypeColour = ReturnType<typeof typeColours>[number];
type Kind = 'side' | 'top';

// keep in sync with TYPE_IDS in src/nanite-lib/gpu/shading.ts
const TYPE_IDS = Array.from({ length: 10 }, (_, i) => { const h = i * 36, f = (n: number): number => Math.max(0, Math.min(1, Math.abs(((h / 60 + n) % 6) - 3) - 1)); return [f(0), f(4), f(2)]; });
const MODES = { geometry: 0, impostors: 1e9 } as const;
const ROUNDS = 5; // calibration rounds
const PERIOD = 64; // the dither's period (ditherShift in src/taa.ts; the jitter's divides it)
const MIN_PIXELS = 3000; // a type covering fewer pixels (real or impostor) is left alone (too few to measure)

/** Screenshot after a few frames with the given impostor threshold and debug mode. */
async function shot(page: Page, imppx: number, debug: number, frames = 16): Promise<Buffer> {
  await page.evaluate(
    async ([px, dbg, frames, PERIOD]) => {
      const d = window.__demo;
      d.forest.u.impostorPx.value = px;
      d.forest.u.debug.value = dbg;
      // (occlusion culling needs a frame of history, and TAA's history ~10 frames: with 3 a shot still held some of
      // the last one, and the per-type pixel counts depended on the view before)
      for (let i = 0; i < frames; i++) await d.renderOnce();
      // One frame's samples alone (TAA's history dropped), at the same phase of the dither and the jitter (both
      // repeat every PERIOD frames) for every shot: a mask and its colours are the same pixels. Averaged, edge pixels
      // blending two types read as a third type's hue (red and blue as Bush 3's magenta), and the colour of a
      // see-through crown's pixel was mostly the ground behind it, which no gain changes. (With TAA off the output
      // path differs and the masks' greens were too pale to classify.)
      while (d.taa.frame % PERIOD !== PERIOD - 1) await d.renderFrame();
      d.taa.reset = true;
      await d.renderFrame();
    },
    [imppx, debug, frames, PERIOD] as [number, number, number, number],
  );
  return page.screenshot();
}

/** sRGB colour ratio geometry / impostor per channel, or null if either is missing. */
const ratio = (g: TypeColour, i: TypeColour): number[] | null => {
  const a = g.rgb, b = i.rgb;
  return a && b ? a.map((v, c) => v / Math.max(b[c], 1)) : null;
};

function printTable(view: string, names: string[], geo: TypeColour[], imp: TypeColour[]): void {
  console.log(`${view}`);
  console.log(`  ${'type'.padEnd(14)} ${'geo px'.padStart(8)} ${'imp px'.padStart(8)}   ${'geo rgb'.padEnd(18)} ${'imp rgb'.padEnd(18)} geo/imp`);
  names.forEach((name, k) => {
    const g = geo[k], i = imp[k], r = ratio(g, i);
    const fmt = (c: number[] | null): string => (c ? c.join(',') : '-').padEnd(18);
    console.log(`  ${name.padEnd(14)} ${String(g.pixels).padStart(8)} ${String(i.pixels).padStart(8)}   ${fmt(g.rgb)} ${fmt(i.rgb)} ${r ? r.map((v) => v.toFixed(2)).join(',') : '-'}`);
  });
}

/** Reads ('get') or writes the page's impostor gains of one view kind ('side' | 'top'). */
/** Pixels per tree type in a mask. */
const countTypes = (mask: Int8Array, n: number): number[] => mask.reduce((acc, t) => (t >= 0 && acc[t]++, acc), new Array<number>(n).fill(0));

/** The page's impostor coverage scale per type of one view kind (impFrame z: side, w: top), or sets it. */
const covsOf = (page: Page, kind: Kind): Promise<number[]> =>
  page.evaluate((k) => window.__demo.forest.impFrameValues.map((v) => (k === 'side' ? v.z : v.w)), kind);
const setCovs = (page: Page, kind: Kind, grows: number[]) =>
  page.evaluate(
    ([k, g]) => window.__demo.forest.impFrameValues.forEach((v, i) => (k === 'side' ? (v.z = g[i]) : (v.w = g[i]))),
    [kind, grows] as [Kind, number[]],
  );

const gainsOf = (page: Page, kind: Kind): Promise<number[][]> =>
  page.evaluate((k) => (window.__demo.forest.impGains?.[k].array as Vector3[]).map((v) => [v.x, v.y, v.z]), kind);
const setGains = (page: Page, kind: Kind, gains: number[][]) =>
  page.evaluate(
    ([k, g]) => (window.__demo.forest.impGains?.[k].array as Vector3[]).forEach((v, i) => v.set(g[i][0], g[i][1], g[i][2])),
    [kind, gains] as [Kind, number[][]],
  );

export async function typeMatch(page: Page, opts: Options, outDir: string) {
  const names = await page.evaluate(() => window.__demo.info().types.map((t) => t.name));
  const n = names.length;
  const calibrate = opts.typematch === 'calibrate';
  const cover = opts.typematch === 'cover';
  const result: Record<string, unknown> = {};
  console.log(`\ntypematch${calibrate ? ' (calibrating)' : ''}: per tree type, real trees (geo) vs impostors (imp); sRGB ratio geo/imp`);
  const imppx = await page.evaluate(() => window.__demo.forest.u.impostorPx.value);
  // (no jitter: the resolve gathers the 3x3 samples round each pixel, and jittered, a pixel between a red and a
  // yellow-green sample read orange, Oak Medium's hue)
  const spread = await page.evaluate(() => [window.__demo.taa.spread, (window.__demo.taa.spread = 0)][0]);
  for (const view of opts.views) {
    await page.evaluate((v) => window.__demo.setView(v), { ...VIEWS[view], zoom: opts.zoom ?? VIEWS[view].zoom ?? 1 });
    const masks = {} as Record<keyof typeof MODES, Int8Array>;
    for (const mode of ['geometry', 'impostors'] as const) {
      const px = MODES[mode];
      at(`typematch ${view}: ${mode} mask`);
      const maskShot = await shot(page, px, 4);
      writeFileSync(join(outDir, `typematch-${view}-${mode}.png`), maskShot);
      masks[mode] = typeMask(maskShot, TYPE_IDS);
    }
    at(`typematch ${view}: geometry colours`);
    const geo = typeColours(await shot(page, MODES.geometry, 0), masks.geometry, n);
    const measureImp = async () => typeColours(await shot(page, MODES.impostors, 0), masks.impostors, n);
    // (pixels per type: what --typematch=cover fits, also by reboots with ?impcovside=...&impcovtop=...)
    const geoMean = countTypes(masks.geometry, n), impMean = countTypes(masks.impostors, n);
    console.log(`  geo/imp px: ${names.map((nm, k) => `${nm} ${impMean[k] < MIN_PIXELS / 3 ? '-' : (geoMean[k] / impMean[k]).toFixed(2)}`).join(', ')}`);
    result[`${view}/pixelRatio`] = Object.fromEntries(names.map((nm, k) => [nm, impMean[k] ? +(geoMean[k] / impMean[k]).toFixed(3) : null]));
    if (cover) {
      // multiplicative steps on the pixel ratio, damped (overlapping crowns hide each other)
      const kind: Kind = (VIEWS[view].pitch ?? 0) <= -60 ? 'top' : 'side';
      let covs = await covsOf(page, kind);
      const geoPx = geoMean;
      for (let round = 1; round <= ROUNDS + 3; round++) {
        at(`typematch ${view}: impostor coverage (${kind}), round ${round}`);
        const impPx = countTypes(typeMask(await shot(page, MODES.impostors, 4), TYPE_IDS), n);
        console.log(`  round ${round}: geo/imp px ${impPx.map((p, k) => (p < MIN_PIXELS / 3 ? '-' : (geoPx[k] / p).toFixed(2))).join(' ')}`);
        covs = covs.map((g, k) => (impPx[k] < MIN_PIXELS / 3 || geoPx[k] < MIN_PIXELS / 3 ? g : g * Math.min(1.5, Math.max(0.67, (geoPx[k] / impPx[k]) ** 0.8))));
        await setCovs(page, kind, covs);
      }
      masks.impostors = typeMask(await shot(page, MODES.impostors, 4), TYPE_IDS);
      console.log(`  ${kind} impCov for src/trees.ts VARIANTS (impCov[${kind === 'side' ? 0 : 1}]): ${names.map((nm, k) => `${nm} ${covs[k].toFixed(2)}`).join(', ')}`);
      result[`${view}/${kind}Covs`] = Object.fromEntries(names.map((nm, k) => [nm, +covs[k].toFixed(2)]));
    }
    let imp = await measureImp();
    printTable(view, names, geo, imp);

    if (calibrate) {
      // multiplicative steps on the sRGB ratio, damped (fog adds a constant, so the response isn't linear)
      const kind: Kind = (VIEWS[view].pitch ?? 0) <= -60 ? 'top' : 'side';
      let gains = await gainsOf(page, kind);
      for (let round = 1; round <= ROUNDS; round++) {
        at(`typematch ${view}: calibrating ${kind}, round ${round}`);
        gains = gains.map((g, k) => {
          const r = ratio(geo[k], imp[k]);
          if (!r || imp[k].pixels < MIN_PIXELS || geo[k].pixels < MIN_PIXELS) return g; // (Bush 3 on slope: ~90 real pixels, gains x100)
          return g.map((v, c) => v * Math.min(2, Math.max(0.5, r[c] ** 1.5)));
        });
        await setGains(page, kind, gains);
        imp = await measureImp();
      }
      printTable(`${view} after calibrating the ${kind} gains`, names, geo, imp);
      console.log(`  ${kind} gains for src/trees.ts VARIANTS (impGain.${kind}):`);
      names.forEach((name, k) => console.log(`    ${name.padEnd(14)} [${gains[k].map((v) => +v.toFixed(2)).join(', ')}]`));
      result[`${view}/${kind}Gains`] = Object.fromEntries(names.map((name, k) => [name, gains[k].map((v) => +v.toFixed(2))]));
    }
    result[view] = names.map((name, k) => ({ name, geometry: geo[k], impostors: imp[k], ratio: ratio(geo[k], imp[k]) }));
  }
  await page.evaluate(([px, sp]) => {
    window.__demo.forest.u.impostorPx.value = px; // (restore)
    window.__demo.forest.u.debug.value = 0;
    window.__demo.taa.spread = sp;
  }, [imppx, spread]);
  return result;
}
