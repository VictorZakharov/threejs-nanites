// The WebGL mode's way to the screen, as main.ts's: the scene into a half-float target (colour, and the wind's screen
// motion for the anti-aliasing), the god rays from its depth (src/godrays.ts), the TAA resolve with temporal
// upscaling (src/taa.ts, src/resolution.ts: the canvas at the display's pixel ratio, the scene at auto quality's),
// then the output pass (tone mapping, the unsharp mask). Before, the scene was drawn straight to a 4x MSAA canvas at
// the scene's resolution (a phone's at 1.25 of its 3, stretched by the browser) with no god rays: the frames read
// darker than WebGPU's (with rays=0 on WebGPU the mean colours matched within ~2/255). Where the GPU can't render
// to float targets (EXT_color_buffer_float), or with ?gltaa=0 or ?taa=0, it's still that.
import * as THREE from 'three/webgpu';
import { mrt, output as colourOutput, vec4 } from 'three/tsl';
import { GodRays } from '../godrays.ts';
import { TAA } from '../taa.ts';
import { createResolution, type Resolution } from '../resolution.ts';
import { mipBias } from '../nanite/shading.ts';

/** Whether this browser's WebGL 2 can draw into half-float targets (?glfloat=0: as if it couldn't). */
export function canRenderFloat(params: URLSearchParams): boolean {
  if (params.get('glfloat') === '0') return false;
  const gl = document.createElement('canvas').getContext('webgl2');
  const ok = Boolean(gl?.getExtension('EXT_color_buffer_float') ?? gl?.getExtension('EXT_color_buffer_half_float'));
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return ok;
}

/** Whether to draw the scene into a half-float target (the TAA's and the god rays'), not the MSAA canvas. */
export function floatTargets(params: URLSearchParams): boolean {
  if (params.get('gltaa') === '0' || params.get('taa') === '0') return false; // (?taa=0: the MSAA canvas, no god rays)
  return canRenderFloat(params);
}

export interface WebGLOutput {
  readonly taa: TAA;
  readonly rays: GodRays;
  readonly res: Resolution;
  /** The scene's pixels (what the culling and the impostors' sizes go by). */
  readonly size: THREE.Vector2;
  /** Whether the scene target has the wind's motion (the trees' and the grass's materials write it then). */
  readonly wind: boolean;
  /** Before anything is culled: this frame's sub-pixel jitter (and the dither's shift), the textures' mip bias. */
  begin(camera: THREE.PerspectiveCamera): void;
  /** The scene into its target, the god rays, the TAA resolve, the output pass. */
  draw(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void;
  /** For compiling ahead: the scene target and its outputs (the programs depend on them; kept between frames). */
  bind(): void;
}

export function createWebGLOutput(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, params: URLSearchParams): WebGLOutput {
  // (samples 0: WebGL's backend takes 1 as multisampled, and blitting its depth failed). One output: no wind motion
  // for the TAA (WebGPU's second target, the trees' sway on screen; here under ~1 px a frame near, so the swaying
  // leaves only soften a little). With it every program wrote two outputs, and ANGLE (Chrome / Edge on Windows)
  // built each again at its first draw in the GPU process, though compiled ahead: the forest floor coming in froze the
  // view ~1.4 s, the grass ~0.3 s, the first frame ~1 s; and the second target cost ~1 ms GPU (?glwind=1: as before).
  const WIND = params.get('glwind') === '1';
  const sceneRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0, depthBuffer: true, count: WIND ? 2 : 1 });
  sceneRT.textures[0].name = 'output';
  if (WIND) sceneRT.textures[1].name = 'wind';
  sceneRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  const sceneMRT = WIND ? mrt({ output: colourOutput, wind: vec4(0) }) : null; // (still everywhere but the trees and the grass)
  sceneMRT?.setClearColor('wind', 0x000000, 0);
  // light shafts through the canopy (R or ?rays=0), added to the scene in the TAA resolve
  const rays = new GodRays(renderer, sceneRT.depthTexture, sunDir, { enabled: params.get('rays') !== '0' });
  const taa = new TAA(renderer, sceneRT, 1, { enabled: params.get('taa') !== '0', extra: rays.at });
  // (alpha 1: the canvas would show the page through cut-out leaves' alpha)
  const pipeline = new THREE.RenderPipeline(renderer, vec4(taa.displayNode, 1));
  const res = createResolution(renderer, camera, sceneRT, params);
  res.fit();
  return {
    taa, rays, res, size: res.render, wind: WIND,
    begin(cam) {
      res.fit();
      taa.jitter(cam, res.render.x, res.render.y);
      mipBias.value = taa.enabled ? -Math.log2(res.ratio()) : 0; // (textures for the output's pixels: the TAA upscales)
    },
    draw(scene, cam) {
      renderer.setRenderTarget(sceneRT);
      renderer.setMRT(sceneMRT);
      renderer.render(scene, cam);
      renderer.setMRT(null);
      rays.render(cam, res.render.x, res.render.y);
      taa.resolve(cam, cam.position);
      renderer.setRenderTarget(null);
      pipeline.render();
      // (back on the scene's target between frames: shaders compiling in the background read the renderer's target
      // and outputs as they build, and the forest floor's compiles after the first frame)
      renderer.setRenderTarget(sceneRT);
      renderer.setMRT(sceneMRT);
    },
    bind() {
      renderer.setRenderTarget(sceneRT);
      renderer.setMRT(sceneMRT);
    },
  };
}
