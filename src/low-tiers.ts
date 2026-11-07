// What each low-end tier of auto quality (src/auto-quality.ts) switches: 1-3 coarser and smaller, 4 the lite tier a first
// visit on a 60-80 Hz display starts at (the AMD PC's reference: a Ryzen 7 5825U's Vega 8 at a 1280x585 CSS window, DPR 3).
import { impMinPx, MIN_PX } from './nanite-lib/index.ts';
import { plainGround } from './terrain.ts';
import { reliefSteps } from './ground/relief.ts';

interface TierParts {
  params: URLSearchParams;
  forest: { u: { impostorPx: { value: number } }; shadowTauScale: number };
  grass: { group: { visible: boolean }; thin(density: number): void };
  res: () => { capOutput(c: number): void; capRatio(c: number): void; capMipBias(c: number): void };
  lighting: { forceFarShadow(on: boolean): void; scaleShadowMap(s: number): void };
  /** (built after the tiers' callback, as `res`: read when a tier is set) */
  rays: () => { enabled: boolean };
}

/** The tier callback auto quality calls on every tier change. */
export function createTierSwitches({ params, forest, grass, res, lighting, rays }: TierParts): (tier: number) => void {
  // (?outratio=) From tier 1 the output stays within this many pixels per scene pixel, along each axis: an AMD iGPU on a DPR 3
  // screen upscaled 960x439 to 3840x1755, 4x, and its TAA and output passes were ~26 of its 44 ms. Past 2x a TAA at 18 fps
  // can't fill the output's pixels anyway (each gets a near sample every ratio^2 frames)
  const OUT_RATIO = Number(params.get('outratio') ?? 2);
  // (?outtier2=) the cap on the output's pixel ratio from tier 2: FullHD at the AMD PC's window (the user asked for it; 1 per
  // CSS px, 1280x585 stretched 3x, read "blurry"). A 1920x877 output costs that PC ~1.7 ms of GPU timers over 1280x585
  const OUT_TIER2 = Number(params.get('outtier2') ?? 1.5);
  // (?miptier=) the mip bias cap from tier 1: textures half a mip level finer than the scene's pixels at most, not log2 of the
  // upscale: on the AMD PC the finer mips were most of the cost of upscaling, and at 0.5 the image looks the same
  const MIP_TIER = Number(params.get('miptier') ?? 0.5);
  // (tier 3 keeps real shadows from a quarter-size map, down to 256: the average far shadow it used to switch to made the
  // forest flat and evenly lit, "no quality" (the user on the AMD PC). There 256 cost +0.3..0.5 ms, 512 +0.8..1.1, and
  // looked nearly alike: softer dapples. ?farshadowtier=3: the old)
  const FAR_SHADOW_TIER = Number(params.get('farshadowtier') ?? Infinity);
  const RELIEF_STEPS = reliefSteps.value; // (its own: ?relief=, 0 on touch)
  const GRASS_TIER3 = Number(params.get('grasstier3') ?? 1.5); // (blades per m² at tier 3)
  // the lite tier (4): what was left at the spawn on the AMD PC at a FullHD output, GPU timers 17.7 -> ~12 ms at 1357x620
  // (the plain ground ~1.7, grass and god rays ~1.2, impostors from 4x the size ~0-4 over the canopy, no finer mips ~1)
  const IMP_LITE = Number(params.get('implite') ?? 4), impPxBase = forest.u.impostorPx.value;
  const liteOff = { grass: false, rays: false };
  // (?liteground=plain: the plain ground near the camera too at tier 4; else the detailed floor without its relief)
  const LITE_PLAIN = params.get('liteground') === 'plain';
  return (tier) => {
    impMinPx.value = tier >= 2 ? 6 : tier >= 1 ? 4 : MIN_PX;
    grass.thin(tier >= 3 ? GRASS_TIER3 : tier >= 2 ? 1.5 : tier >= 1 ? 2 : Infinity);
    const rs = res();
    rs.capOutput(tier >= 2 ? OUT_TIER2 : Infinity);
    rs.capRatio(tier >= 1 ? OUT_RATIO : Infinity);
    rs.capMipBias(tier >= 4 ? 0 : tier >= 1 ? MIP_TIER : Infinity);
    plainGround.on = (tier >= 4 && LITE_PLAIN) || params.get('plainground') === '1';
    forest.u.impostorPx.value = impPxBase * (tier >= 4 ? IMP_LITE : 1);
    // (hidden by the tier, shown again by it: a switch the menu turned off stays off)
    if (tier >= 4 && grass.group.visible) (grass.group.visible = false), (liteOff.grass = true);
    else if (tier < 4 && liteOff.grass) (grass.group.visible = true), (liteOff.grass = false);
    const r = rays();
    if (tier >= 4 && r.enabled) (r.enabled = false), (liteOff.rays = true);
    else if (tier < 4 && liteOff.rays) (r.enabled = true), (liteOff.rays = false);
    lighting.forceFarShadow(tier >= FAR_SHADOW_TIER);
    lighting.scaleShadowMap(tier >= 3 ? 0.25 : tier >= 2 ? 0.5 : 1);
    forest.shadowTauScale = tier >= 3 ? 4 : tier >= 2 ? 2 : 1; // (casters as coarse as the map: src/nanite-lib/gpu/renderer.ts)
    // (the floor's parallax relief in 8 steps, not 32: 2.2 of 39 ms on the AMD PC at 1080p; it only shows up close)
    reliefSteps.value = tier >= 4 ? 0 : tier >= 1 ? Math.min(RELIEF_STEPS, 8) : RELIEF_STEPS;
  };
}
