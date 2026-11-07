// Resolution: the canvas (the output) at the display's own pixel ratio, up to OUT_MAX, and the scene rendered below
// it; the TAA resolve (src/taa.ts) rebuilds the output's pixels from the scene's jittered ones over the frames
// (temporal upscaling, as UE's TSR or AMD's FSR 2). Before, the canvas itself was rendered at the lower resolution and
// the browser stretched it: a phone with 3.75 device pixels per CSS pixel showed 1.5 (less under auto quality), each
// rendered pixel smeared over 2.5 x 2.5 of its own (the user: "blurry, no detail"; "you render 9 times fewer pixels
// than needed" on an iPhone). Auto quality's scale moves only the scene's resolution now, from half the base ratio up
// to the output's (`maxScale`: above 1 where the GPU has room, on a screen denser than 1.5).
// `?pr=` the scene's pixel ratio at scale 1 (default the device's, at most 1.5), `?outpr=` the output's,
// `?taau=0` no upscaling: the canvas at the scene's resolution, as before.
import * as THREE from 'three/webgpu';

const OUT_MAX = 3;
// (?out4k=1: the canvas stays at the display's pixels under the caps, the output pass upscaling the TAA's result to it. A plain
// bilinear upscale looked the same as the browser's stretch (--ab outpr=1|taapr=1), at a full-size output pass: off until the
// upscale itself adds something)
const FULL_OUT = new URLSearchParams(location.search).get('out4k') === '1'; // (a phone's 3.75 at full size: 4.5M pixels for the resolve and the output pass)

export interface Resolution {
  /** The scene's size in pixels: the culling, the HZB, the software rasterizer, the draws. */
  readonly render: THREE.Vector2;
  /** The canvas's size in pixels: the output pass. Always the display's (up to OUT_MAX): the caps below shrink the TAA's, not it. */
  readonly output: THREE.Vector2;
  /**
   * The TAA's history (src/taa.ts): the output's size, or less under auto quality's caps; the output pass upscales it to the
   * canvas. The caps used to shrink the canvas and the browser stretched it, 3x on the AMD PC's DPR 3 screen at tier 2 (the
   * user: "it defeats the purpose to run on 4k screen").
   */
  readonly taa: THREE.Vector2;
  /** Pixel ratios: the scene's at scale 1, the canvas's. */
  readonly basePR: number;
  readonly outPR: number;
  /** Caps the canvas's pixel ratio (auto quality's low-end tier; Infinity: none). Applied at the next `fit()`, at a frame's start: resizing clears the canvas. */
  capOutput(pr: number): void;
  /**
   * Caps the canvas's pixel ratio at `r` times the scene's, but not under one per CSS pixel (auto quality's tier 1; Infinity:
   * none). As the scene's resolution comes down, the output follows it. Applied at the next frame's `fit()`.
   */
  capRatio(r: number): void;
  /** Upscaling on (the canvas at `outPR`) or off (at the scene's ratio, stretched by the browser: Profile GPU). */
  readonly upscale: boolean;
  setUpscale(on: boolean): void;
  /** Output pixels per scene pixel, along each axis (1: none). */
  ratio(): number;
  /**
   * The textures' mip bias for the output's pixels: -log2(ratio()), at most `capMipBias`'s levels finer. Sampling finer mips
   * for an upscaled scene cost an AMD iGPU (the reference low-end PC) most of its frame: 960x439 into 1920x877, 18.1 ms
   * uncapped, 15.6 at 0.5 (60 fps), 14.5 at 0, the image at 0.5 like uncapped; 480x220 into 1920x877, 22.6 -> 10.4 at 0.
   */
  mipBias(): number;
  /** Caps how many mip levels finer than the scene's pixels the textures sample (auto quality's tiers; `?mipbiasmax=`). */
  capMipBias(levels: number): void;
  /** Follows the window (every frame: a resize while loading fired before any listener existed). */
  fit(toOutput?: boolean): void;
  /** The scene's resolution scale (auto quality: of `basePR`). */
  setScale(s: number): void;
  /** The highest useful scale: the scene at the output's resolution (1 without upscaling). */
  maxScale(): number;
}

export function createResolution(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera, sceneRT: THREE.RenderTarget, params: URLSearchParams): Resolution {
  const basePR = Number(params.get('pr') ?? Math.min(window.devicePixelRatio, 1.5));
  let upscale = params.get('taau') !== '0' && params.get('taa') !== '0';
  const outPR = Number(params.get('outpr') ?? Math.max(basePR, Math.min(window.devicePixelRatio, OUT_MAX)));
  const render = new THREE.Vector2(), output = new THREE.Vector2(), taa = new THREE.Vector2(), view = new THREE.Vector2();
  let scale = 1, cap = Infinity, ratioCap = Infinity, mipCap = Infinity;
  const MIP_MAX = Number(params.get('mipbiasmax') ?? Infinity); // (a fixed cap: the harness's A/B)
  const outNow = (): number => Math.min(outPR, cap, Math.max(1, ratioCap * basePR * scale));
  renderer.setPixelRatio(upscale ? outPR : basePR);
  const res: Resolution = {
    render, output, taa, basePR,
    get outPR() {
      return outNow();
    },
    capOutput(pr) {
      cap = pr;
    },
    capRatio(r) {
      ratioCap = r;
    },
    get upscale() {
      return upscale;
    },
    setUpscale(on) {
      upscale = on;
      renderer.setPixelRatio(on ? (FULL_OUT ? outPR : outNow()) : basePR * scale);
      res.fit();
    },
    ratio: () => taa.x / render.x,
    mipBias: () => -Math.min(mipCap, MIP_MAX, Math.log2(res.ratio())),
    capMipBias(levels) {
      mipCap = levels;
    },
    maxScale: () => (upscale ? Math.max(1, outNow() / basePR) : 1),
    fit(toOutput = true) {
      const canvasPR = FULL_OUT ? outPR : outNow();
      if (toOutput && upscale && renderer.getPixelRatio() !== canvasPR) renderer.setPixelRatio(canvasPR);
      renderer.getSize(view);
      const w = window.innerWidth, h = window.innerHeight;
      if (view.x !== w || view.y !== h) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
      renderer.getDrawingBufferSize(output);
      // (the same share of the output both ways: one ratio, so output pixels map evenly onto scene pixels)
      const t = upscale ? Math.min(1, outNow() / renderer.getPixelRatio()) : 1;
      taa.set(Math.max(1, Math.round(output.x * t)), Math.max(1, Math.round(output.y * t)));
      const r = Math.min(1, (basePR * scale) / (renderer.getPixelRatio() * t));
      render.set(Math.max(1, Math.round(taa.x * r)), Math.max(1, Math.round(taa.y * r)));
      if (sceneRT.width !== render.x || sceneRT.height !== render.y) sceneRT.setSize(render.x, render.y);
    },
    setScale(s) {
      scale = s;
      if (!upscale) renderer.setPixelRatio(basePR * s); // (the canvas follows the scene, as before)
      // (the scene's target now; a new output size (capRatio) waits for the next frame's start: resizing the canvas clears it,
      // and set after a frame the browser shows that frame blank)
      res.fit(!upscale);
    },
  };
  return res;
}
