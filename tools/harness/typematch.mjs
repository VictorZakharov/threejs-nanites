// --typematch: how well the impostors match the real trees, per tree type. Each view is drawn all geometry (imppx 0)
// and all impostors (imppx huge), each once with debug=4 (a flat colour per tree type: the mask) and once normally
// (the colours). Per type: pixels covered and mean colour in both, and the colour ratio geometry / impostor.
//
// --typematch=calibrate also adjusts the impostor gains in the page (forest.impGains, live uniforms) until the
// colours match, and prints the gains to put into VARIANTS in src/trees.ts. Views looking down steeply (pitch
// <= -60) calibrate the top-down gains, the others the side gains: use d550 for top and fogline for side (distant
// trees only: near trees as geometry get real shadows that impostors can't have).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWS } from './views.mjs';
import { typeMask, typeColours } from './images.mjs';
import { at } from './status.mjs';

// keep in sync with TYPE_IDS in src/nanite/shading.ts
const TYPE_IDS = Array.from({ length: 9 }, (_, i) => { const h = i * 40, f = (n) => Math.max(0, Math.min(1, Math.abs(((h / 60 + n) % 6) - 3) - 1)); return [f(0), f(4), f(2)]; });
const MODES = { geometry: 0, impostors: 1e9 };
const ROUNDS = 5; // calibration rounds
const MIN_PIXELS = 3000; // a type covering fewer impostor pixels is left alone (too few to measure)

/** Screenshot after a few frames with the given impostor threshold and debug mode. */
async function shot(page, imppx, debug) {
  await page.evaluate(
    async ([px, dbg]) => {
      const d = window.__demo;
      d.forest.u.impostorPx.value = px;
      d.forest.u.debug.value = dbg;
      for (let i = 0; i < 3; i++) await d.renderOnce(); // (occlusion culling needs a frame of history)
    },
    [imppx, debug],
  );
  return page.screenshot();
}

/** sRGB colour ratio geometry / impostor per channel, or null if either is missing. */
const ratio = (g, i) => (g.rgb && i.rgb ? g.rgb.map((v, c) => v / Math.max(i.rgb[c], 1)) : null);

function printTable(view, names, geo, imp) {
  console.log(`${view}`);
  console.log(`  ${'type'.padEnd(14)} ${'geo px'.padStart(8)} ${'imp px'.padStart(8)}   ${'geo rgb'.padEnd(18)} ${'imp rgb'.padEnd(18)} geo/imp`);
  names.forEach((name, k) => {
    const g = geo[k], i = imp[k], r = ratio(g, i);
    const fmt = (c) => (c ? c.join(',') : '-').padEnd(18);
    console.log(`  ${name.padEnd(14)} ${String(g.pixels).padStart(8)} ${String(i.pixels).padStart(8)}   ${fmt(g.rgb)} ${fmt(i.rgb)} ${r ? r.map((v) => v.toFixed(2)).join(',') : '-'}`);
  });
}

/** Reads ('get') or writes the page's impostor gains of one view kind ('side' | 'top'). */
const gainsOf = (page, kind) => page.evaluate((k) => window.__demo.forest.impGains[k].array.map((v) => [v.x, v.y, v.z]), kind);
const setGains = (page, kind, gains) =>
  page.evaluate(([k, g]) => window.__demo.forest.impGains[k].array.forEach((v, i) => v.set(...g[i])), [kind, gains]);

export async function typeMatch(page, opts, outDir) {
  const names = await page.evaluate(() => window.__demo.info().types.map((t) => t.name));
  const n = names.length;
  const calibrate = opts.typematch === 'calibrate';
  const result = {};
  console.log(`\ntypematch${calibrate ? ' (calibrating)' : ''}: per tree type, real trees (geo) vs impostors (imp); sRGB ratio geo/imp`);
  const imppx = await page.evaluate(() => window.__demo.forest.u.impostorPx.value);
  for (const view of opts.views) {
    await page.evaluate((v) => window.__demo.setView(v), { ...VIEWS[view], zoom: opts.zoom ?? VIEWS[view].zoom ?? 1 });
    const masks = {};
    for (const [mode, px] of Object.entries(MODES)) {
      at(`typematch ${view}: ${mode} mask`);
      const maskShot = await shot(page, px, 4);
      writeFileSync(join(outDir, `typematch-${view}-${mode}.png`), maskShot);
      masks[mode] = typeMask(maskShot, TYPE_IDS);
    }
    at(`typematch ${view}: geometry colours`);
    const geo = typeColours(await shot(page, MODES.geometry, 0), masks.geometry, n);
    const measureImp = async () => typeColours(await shot(page, MODES.impostors, 0), masks.impostors, n);
    let imp = await measureImp();
    printTable(view, names, geo, imp);

    if (calibrate) {
      // multiplicative steps on the sRGB ratio, damped (fog adds a constant, so the response isn't linear)
      const kind = (VIEWS[view].pitch ?? 0) <= -60 ? 'top' : 'side';
      let gains = await gainsOf(page, kind);
      for (let round = 1; round <= ROUNDS; round++) {
        at(`typematch ${view}: calibrating ${kind}, round ${round}`);
        gains = gains.map((g, k) => {
          const r = ratio(geo[k], imp[k]);
          if (!r || imp[k].pixels < MIN_PIXELS) return g;
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
  await page.evaluate((px) => {
    window.__demo.forest.u.impostorPx.value = px; // (restore)
    window.__demo.forest.u.debug.value = 0;
  }, imppx);
  return result;
}
