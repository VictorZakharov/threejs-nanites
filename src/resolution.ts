// Resolution: the canvas (the output) at the display's own pixel ratio, up to OUT_MAX, and the scene rendered below
// it; the TAA resolve (src/taa.ts) rebuilds the output's pixels from the scene's jittered ones over the frames
// (temporal upscaling, as UE's TSR or AMD's FSR 2). Before, the canvas itself was rendered at the lower resolution and
// the browser stretched it: a phone with 3.75 device pixels per CSS pixel showed 1.5 (less under auto quality), each
// rendered pixel smeared over 2.5 x 2.5 of its own (the user: "blurry, no detail"; "you render 9 times fewer pixels
// than needed" on an iPhone). Auto quality's scale moves only the scene's resolution now.
// `?pr=` the scene's pixel ratio at scale 1 (default the device's, at most 1.5), `?outpr=` the output's,
// `?taau=0` no upscaling: the canvas at the scene's resolution, as before.
import * as THREE from 'three/webgpu';

const OUT_MAX = 3; // (a phone's 3.75 at full size: 4.5M pixels for the resolve and the output pass)

export interface Resolution {
  /** The scene's size in pixels: the culling, the HZB, the software rasterizer, the draws. */
  readonly render: THREE.Vector2;
  /** The canvas's size in pixels: the TAA history and the output pass. */
  readonly output: THREE.Vector2;
  /** Pixel ratios: the scene's at scale 1, the canvas's. */
  readonly basePR: number;
  readonly outPR: number;
  readonly upscale: boolean;
  /** Output pixels per scene pixel, along each axis (1: none). */
  ratio(): number;
  /** Follows the window (every frame: a resize while loading fired before any listener existed). */
  fit(): void;
  /** The scene's resolution scale (auto quality: of `basePR`). */
  setScale(s: number): void;
}

export function createResolution(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera, sceneRT: THREE.RenderTarget, params: URLSearchParams): Resolution {
  const basePR = Number(params.get('pr') ?? Math.min(window.devicePixelRatio, 1.5));
  const upscale = params.get('taau') !== '0' && params.get('taa') !== '0';
  const outPR = upscale ? Number(params.get('outpr') ?? Math.max(basePR, Math.min(window.devicePixelRatio, OUT_MAX))) : basePR;
  const render = new THREE.Vector2(), output = new THREE.Vector2(), view = new THREE.Vector2();
  let scale = 1;
  renderer.setPixelRatio(outPR);
  const res: Resolution = {
    render, output, basePR, outPR, upscale,
    ratio: () => output.x / render.x,
    fit() {
      renderer.getSize(view);
      const w = window.innerWidth, h = window.innerHeight;
      if (view.x !== w || view.y !== h) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
      renderer.getDrawingBufferSize(output);
      // (the same share of the output both ways: one ratio, so output pixels map evenly onto scene pixels)
      const r = Math.min(1, (basePR * scale) / renderer.getPixelRatio());
      render.set(Math.max(1, Math.round(output.x * r)), Math.max(1, Math.round(output.y * r)));
      if (sceneRT.width !== render.x || sceneRT.height !== render.y) sceneRT.setSize(render.x, render.y);
    },
    setScale(s) {
      scale = s;
      if (!upscale) renderer.setPixelRatio(basePR * s); // (the canvas follows the scene, as before)
      res.fit();
    },
  };
  return res;
}
