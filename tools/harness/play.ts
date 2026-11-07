// --play: flies a fixed route with real input, as a person does (the user on the AMD PC: "turning lags", which the probes'
// yaw written into the page didn't reproduce: 60 fps, no frame over 25 ms). A click captures the mouse (pointer lock),
// then keys are held and the mouse moved through Chrome's input pipeline, with the page's own loop and auto quality, and
// the performance panel's report is printed at the end (its fps, GPU queue and slow frames by cause). Use --query=perf=1;
// on the AMD PC: npm run remote -- --headed --device=amd --views=canopy --play "--query=perf=1".
import type { Page } from 'playwright-core';
import type { Options } from './options.ts';
import { at } from './status.ts';
import { VIEWS } from './views.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// (the page's mouse look: 0.0022 rad per pixel, src/controls.ts)
const RAD_PER_PX = 0.0022;

/** Moves the mouse by `rad` of yaw (and `pitch` rad) over `ms`, a step per display frame (`pos.k`: rad per pixel, measured). */
async function look(page: Page, pos: { x: number; y: number; k: number }, rad: number, ms: number, pitch = 0): Promise<void> {
  const steps = Math.max(1, Math.round(ms / 16.7)), dx = -rad / pos.k / steps, dy = -pitch / pos.k / steps;
  for (let k = 0; k < steps; k++) {
    pos.x += dx;
    pos.y += dy;
    await page.mouse.move(pos.x, pos.y);
    await sleep(16.7);
  }
}

/** Radians of yaw per pixel the mouse moves, measured (a first try turned 752 rad for a 22 rad route: measure, don't assume). */
async function calibrate(page: Page, pos: { x: number; y: number; k: number }): Promise<void> {
  const yaw = (): Promise<number> => page.evaluate(() => window.__demo.controls.yaw);
  const y0 = await yaw();
  pos.x += 20;
  await page.mouse.move(pos.x, pos.y);
  await sleep(200);
  pos.k = Math.abs((await yaw()) - y0) / 20 || RAD_PER_PX;
}

async function hold(page: Page, keys: string[], ms: number, during?: () => Promise<void>): Promise<void> {
  for (const k of keys) await page.keyboard.down(k);
  const t0 = Date.now();
  if (during) await during();
  await sleep(Math.max(0, ms - (Date.now() - t0)));
  for (const k of keys) await page.keyboard.up(k);
}

export async function play(page: Page, opts: Options) {
  const result: Record<string, unknown> = {};
  // (never on the machine someone is using: a headless browser's pointer lock still confines the real cursor (Windows'
  // ClipCursor) to its hidden window. Run here, it held the user's mouse in a small part of the screen, over and over.
  // Only a visible window on the test PC, which `npm run remote -- --headed` sets up)
  if (process.env.HARNESS_HEADED !== '1' || !process.env.HARNESS_REMOTE) {
    console.error('--play captures the mouse: only with npm run remote -- --headed (never locally, never headless)');
    return { skipped: true };
  }
  for (const name of opts.views) {
    at(`play ${name}`);
    await page.evaluate((v) => window.__demo.setView(v), { ...VIEWS[name], zoom: 1 });
    await page.evaluate(() => window.__demo.live(true));
    await page.bringToFront();
    const size = page.viewportSize() ?? { width: 1280, height: 720 };
    const pos = { x: size.width / 2, y: size.height / 2, k: RAD_PER_PX };
    // (Chrome refuses a new pointer lock for ~1 s after one ends: the previous view's Esc. Click again until it holds)
    for (let k = 0; k < 5 && !(await page.evaluate(() => document.pointerLockElement !== null)); k++) {
      await page.mouse.click(pos.x, pos.y);
      await sleep(1500);
    }
    await sleep(opts.playwait * 1000); // (auto quality settles)
    const locked = await page.evaluate(() => document.pointerLockElement !== null);
    await calibrate(page, pos);
    const yaw0 = await page.evaluate(() => window.__demo.controls.yaw);
    // (the route: turn round, fly on fast, look about, climb, turn round twice quickly)
    await look(page, pos, 2 * Math.PI, 4000);
    await hold(page, ['ShiftLeft', 'KeyW'], 4000);
    await look(page, pos, Math.PI / 2, 800);
    await look(page, pos, -Math.PI, 1200);
    await look(page, pos, Math.PI / 2, 800, -0.3);
    await hold(page, ['Space'], 3000, () => look(page, pos, Math.PI, 3000));
    await look(page, pos, 0, 300, 0.3);
    await look(page, pos, 4 * Math.PI, 4000);
    await hold(page, ['KeyW'], 3000, () => look(page, pos, -Math.PI, 3000));
    const turned = await page.evaluate((y0) => window.__demo.controls.yaw - y0, yaw0);
    const report = await page.evaluate(() => window.__demo.perfReport());
    await page.keyboard.press('Escape'); // (gives the mouse back)
    await page.evaluate(() => window.__demo.live(false));
    result[name] = { locked, radPerPx: pos.k, turned: +turned.toFixed(2), report };
    console.log(`play ${name}: pointer locked ${locked}, ${pos.k.toFixed(5)} rad/px, turned ${turned.toFixed(2)} rad (route: ${(7 * Math.PI).toFixed(2)})`);
    console.log(report ?? '(no report: use --query=perf=1)');
  }
  return result;
}
