// Temporal anti-aliasing: the camera is shifted by a different sub-pixel offset every frame (Halton 2,3), and a
// resolve pass blends each new frame into a history: the previous result, looked up where this pixel was a frame
// ago. Small trees whose leaves and twigs are thinner than a pixel otherwise shimmer as the camera moves (they hit
// or miss pixel centres), which made the band where trees turn into steady impostors visible in motion.
//
// Where a pixel was: rebuilt from the depth buffer and last frame's camera (static scenery). Wind and the impostors
// turning with the camera are small per frame; the history is clipped to the colour range of the pixel's 3x3
// neighbourhood, which keeps them (and anything newly uncovered) from ghosting. The planet's curvature moves with
// the viewer (see planet.js), so the reprojection undoes this frame's drop and applies last frame's.
//
// Upscaling (src/resolution.ts): the history and the output are at the canvas's resolution, the scene may be below
// it. Each output pixel takes the 3x3 scene samples round its centre, each weighted by how near it lands (the jitter
// moves the samples across the output pixels from frame to frame); the history keeps the weight it has gathered
// (its alpha), so a pixel the samples have covered well changes slowly, and one that lost its history (uncovered,
// clipped) takes new samples quickly. At one output pixel per scene pixel it flickers less than the plain blend of
// the pixel's own sample (turning test: slope 1340 -> 1222, fogline 2359 -> 2183).
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, texture, textureLoad, ivec2, int, vec2, vec3, vec4, float, max, min, select, clamp, dot, sqrt, exp,
  screenUV, screenSize, abs,
} from 'three/tsl';
import { PLANET_RADIUS } from './planet.ts';
import { ditherShift } from './nanite-lib/index.ts';
import type { Float, IVec2, Vec2, Vec3 } from './types.ts';

const halton = (i: number, b: number): number => {
  let f = 1, r = 0;
  for (; i > 0; i = Math.floor(i / b)) r += (f /= b) * (i % b);
  return r;
};
const params = new URLSearchParams(location.search);
// the jitter's spread (scene pixels; 1 = the whole pixel): with MSAA, which already smooths geometric edges, half a
// pixel (the jitter is for what's smaller than its samples, and a narrower spread keeps the image sharper); without,
// the whole pixel: the jitter is the anti-aliasing
const spreadOf = (samples: number): number => Number(params.get('taajitter') ?? (samples > 1 ? 0.5 : 1));
// (the samples must visit every output pixel a scene pixel covers: 8 offsets for each, as FSR 2)
const phasesOf = (ratio: number): number => Math.max(8, Math.ceil(8 * ratio * ratio));
// the weight of a sample d output pixels from a pixel's centre: exp(-k d^2 / ratio), a Gaussian narrower than a
// pixel at one output pixel per scene pixel (k 2.29, UE's Blackman-Harris fit, was visibly softer than the plain
// resolve; 5 is as sharp and flickers less turning: slope 1340 -> 1294, fogline 2359 -> 2266), wider when upscaling
// (the samples are further apart: at 5 the cobbles a few metres off came out speckled at 2x)
const KERNEL = Number(params.get('taakernel') ?? 5);
/** The mean weight a frame's 3x3 samples bring an output pixel, at `ratio` output pixels per scene pixel. */
const meanWeight = (ratio: number): number => {
  let sum = 0;
  const n = 8;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let y = -1; y <= 1; y++)
        for (let x = -1; x <= 1; x++) sum += Math.exp(-KERNEL * (((i + 0.5) / n - 0.5 + x) ** 2 + ((j + 0.5) / n - 0.5 + y) ** 2) * ratio);
  return sum / (n * n);
};

/** Colour <-> YCoCg (the neighbourhood box is tighter around foliage greens in it than in RGB). */
const toYCoCg = (c: Vec3): Vec3 => vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25)));
const toRGB = (y: Vec3): Vec3 => vec3(y.x.add(y.y).sub(y.z), y.x.add(y.z), y.x.sub(y.y).sub(y.z));
// The history is blended in a perceptual space (the square root of linear light, near the display's gamma), not in
// linear light: half a dark needle against the bright sky averaged in linear light reads much brighter than half on
// screen, and the far crowns' tips, sub-pixel speckles that the jitter moves, turned into pale ghosts against the
// sky (the user: "ghosted peaks"). `?taaspace=linear` for the old blend.
const PERCEPTUAL = params.get('taaspace') !== 'linear';
const enc = (c: Vec3): Vec3 => (PERCEPTUAL ? sqrt(max(c, vec3(0))) : c);
const dec = (c: Vec3): Vec3 => (PERCEPTUAL ? c.mul(c) : c);

export class TAA {
  /**
   * `sceneRT`: the MSAA scene target (colour + depth texture), `samples` its sample count. `extra(uv)`: light added
   * to the scene before the resolve (the god rays: their noisy march is averaged with the rest).
   */
  readonly renderer: THREE.WebGPURenderer;
  readonly sceneRT: THREE.RenderTarget;
  readonly extra: ((uv: Vec2) => Vec3) | null;
  spread: number; // the jitter's spread (scene pixels; the harness's --typematch sets 0)
  readonly frames: number; // how many frames' worth of samples the history keeps (?taaframes=, else 1 / feedback)
  enabled: boolean;
  frame = 0;
  reset = true;
  readonly history: THREE.RenderTarget[];
  readonly u;
  readonly viewProj = new THREE.Matrix4();
  readonly prevViewProjCPU = new THREE.Matrix4();
  readonly prevViewer = new THREE.Vector3();
  readonly outSize = new THREE.Vector2();
  lastRatio = 0;
  readonly historyTex: THREE.TextureNode;
  readonly quad: THREE.QuadMesh;
  /** What the output pass shows: the latest resolved frame (or the scene itself with TAA off). */
  readonly outputTex: THREE.TextureNode;
  readonly displayNode: Vec3;

  constructor(
    renderer: THREE.WebGPURenderer,
    sceneRT: THREE.RenderTarget,
    samples: number,
    { enabled = true, feedback = Number(params.get('taafeedback') ?? 0.1), extra = null }: { enabled?: boolean; feedback?: number; extra?: ((uv: Vec2) => Vec3) | null } = {},
  ) {
    this.extra = extra;
    this.spread = spreadOf(samples);
    this.frames = Number(params.get('taaframes') ?? 1 / feedback);
    this.renderer = renderer;
    this.sceneRT = sceneRT;
    this.enabled = enabled;
    const make = () => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.history = [make(), make()];
    this.u = {
      invViewProj: uniform(new THREE.Matrix4()), // this frame, unjittered
      prevViewProj: uniform(new THREE.Matrix4()), // last frame, unjittered
      reproject: uniform(new THREE.Matrix4()), // prevViewProj x invViewProj (this frame's clip -> last frame's)
      viewer: uniform(new THREE.Vector3()),
      prevViewer: uniform(new THREE.Vector3()),
      resetting: uniform(1),
      renderSize: uniform(new THREE.Vector2(1, 1)), // the scene's pixels
      jitterOff: uniform(new THREE.Vector2()), // this frame's samples from their texels' centres (scene pixels, y down)
      ratio: uniform(1), // output pixels per scene pixel
      maxWeight: uniform(9), // the most weight the history keeps
      kernel: uniform(-KERNEL), // (-KERNEL / ratio)
      sharpen: uniform(Number(params.get('sharpen') ?? 0.25)), // the output's unsharp mask (TAA softens a little)
      off: uniform(enabled ? 0 : 1), // (TAA off: the output adds `extra` itself)
    };
    this.historyTex = texture(this.history[0].texture);
    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = this._resolveNode(sceneRT, samples);
    mat.toneMapped = false;
    this.quad = new THREE.QuadMesh(mat);
    this.outputTex = texture(sceneRT.texture);
    // ... through a light unsharp mask (4 neighbours) when TAA is on
    const px = vec2(1).div(screenSize);
    const c = extra ? this.outputTex.rgb.add(extra(screenUV).mul(this.u.off)) : this.outputTex.rgb;
    // (in a compressed space, x / (1 + x): in linear HDR the sun's disc, far above 1, pulled the pixels around it
    // below zero, a black ring round the sun, and isolated dark specks against the sky went black)
    const squash = (v: Vec3): Vec3 => v.div(v.add(1));
    const ring = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, y]) => squash(this.outputTex.sample(screenUV.add(px.mul(vec2(x, y)))).rgb));
    const avg = ring.reduce((a, b) => a.add(b)).mul(0.25);
    const t = clamp(squash(c).add(squash(c).sub(avg).mul(this.u.sharpen)), 0, 0.999);
    this.displayNode = t.div(t.oneMinus());
    // (?taadebug=1: shows the trees' wind motion instead, x red / y green, x200)
    if (params.get('taadebug') === '2') this.displayNode = this.outputTex.rgb;
    if (params.get('taadebug') === '1' && sceneRT.textures[1]) this.displayNode = abs(textureLoad(sceneRT.textures[1], ivec2(screenUV.mul(this.u.renderSize))).xyz).mul(200);
  }

  _resolveNode(sceneRT: THREE.RenderTarget, samples: number) {
    const u = this.u;
    // (the scene target gets its depth texture before the TAA is made, see main.ts)
    const colour = sceneRT.texture, depth = sceneRT.depthTexture!, wind = sceneRT.textures[1];
    const invTwoR = 1 / (2 * PLANET_RADIUS);
    return Fn(() => {
      const R = u.renderSize;
      // this output pixel's centre among the scene's samples (scene pixels: a sample sits at its texel's centre plus
      // this frame's jitter), and the texel whose sample lands nearest it
      const at = screenUV.mul(R).sub(u.jitterOff);
      const p = ivec2(clamp(at.floor(), vec2(0), R.sub(1))).toVar();
      const sceneAt = (q: IVec2): Vec3 => {
        const c = textureLoad(colour, q).rgb;
        return this.extra ? c.add(this.extra(vec2(q).add(0.5).div(R))) : c;
      };
      // the 3x3 samples round it: this frame's value at the pixel (each weighted by how far from its centre it
      // landed: the nearest alone left speckles and flickered more), the neighbourhood's colour mean and spread
      // (variance clipping box, in YCoCg) and the nearest depth (dilated: thin twigs reproject with the depth of what
      // they are, not of the sky behind them)
      const sum = vec3(0).toVar(), w = float(0).toVar();
      const m1 = vec3(0).toVar(), m2 = vec3(0).toVar();
      const zMin = float(1).toVar();
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const q = ivec2(clamp(vec2(p).add(vec2(dx, dy)), vec2(0), R.sub(1)));
          const e = enc(sceneAt(q));
          const dq = vec2(q).add(0.5).sub(at).mul(u.ratio); // (output pixels)
          const wq = exp(dot(dq, dq).mul(u.kernel));
          sum.addAssign(e.mul(wq));
          w.addAssign(wq);
          const c = toYCoCg(e);
          m1.addAssign(c);
          m2.addAssign(c.mul(c));
          zMin.assign(min(zMin, textureLoad(depth, q, int(0)).x));
        }
      for (let k = 1; k < samples; k++) zMin.assign(min(zMin, textureLoad(depth, p, int(k)).x));
      const mean = m1.div(9);
      const sigma = sqrt(max(m2.div(9).sub(mean.mul(mean)), vec3(0)));
      const boxMax = mean.add(sigma.mul(1.25)); // (the clipping box: mean +- 1.25 sigma)
      // where this pixel was last frame: one matrix from this frame's clip space to last frame's, multiplied on
      // the CPU in double precision (rebuilding the world position in float32 from a depth near 1 was off by up to
      // half a pixel with the camera standing still: 3 km away through the 5x zoom, every frame blurred the
      // history and the clipping then thinned the distant crowns)
      // (WebGL's clip space has z in -1..1, the depth buffer 0..1: the WebGL mode's reprojection was off by the
      // depth wherever the camera moved, and the view from 150 m flickered ~35x more than WebGPU's: plazahigh --dolly)
      const zNdc = this.renderer.coordinateSystem === THREE.WebGLCoordinateSystem ? zMin.mul(2).sub(1) : zMin;
      const ndc = vec4(screenUV.x.mul(2).sub(1), screenUV.y.mul(-2).add(1), zNdc, 1);
      const w4 = u.invViewProj.mul(ndc);
      const world = w4.xyz.div(w4.w);
      const drop = (pos: Vec3, v: Vec3): Float => {
        const dx = pos.x.sub(v.x), dz = pos.z.sub(v.z);
        return dx.mul(dx).add(dz.mul(dz)).mul(invTwoR);
      };
      // (the planet's curve moves with the viewer: undo this frame's drop, apply last frame's; small, so the
      // imprecise world position is good enough for it)
      const lift = drop(world, u.viewer).sub(drop(world, u.prevViewer)).mul(w4.w);
      const prevClip = u.reproject.mul(ndc).add(u.prevViewProj.mul(vec4(0, lift, 0, 0)));
      // (minus the trees' own motion in the wind: depth only knows where the scenery was)
      const prevUv = vec2(prevClip.x.div(prevClip.w).mul(0.5).add(0.5), prevClip.y.div(prevClip.w).mul(-0.5).add(0.5))
        .sub(wind ? textureLoad(wind, p).xy : vec2(0)); // (none in the WebGL mode: src/webgl/output.ts)
      const onScreen = prevUv.x.greaterThanEqual(0).and(prevUv.x.lessThanEqual(1)).and(prevUv.y.greaterThanEqual(0)).and(prevUv.y.lessThanEqual(1));
      // history, clipped towards the mean into the box (clipping, not clamping: no colour shift at the box corners)
      const hist = toYCoCg(enc(this._catmullRom(prevUv)));
      const d = hist.sub(mean);
      const ext = max(boxMax.sub(mean), vec3(1e-4));
      const outside = max(max(abs(d.x).div(ext.x), abs(d.y).div(ext.y)), abs(d.z).div(ext.z)); // (> 1: outside the box)
      const clipped = toRGB(select(outside.greaterThan(1), mean.add(d.div(outside)), hist));
      // the history's weight: none off screen or after a reset, less the further outside the box it was
      const kept = select(onScreen.and(u.resetting.equal(0)), min(this.historyTex.sample(prevUv).a, u.maxWeight), float(0));
      const wHist = kept.mul(clamp(float(2).sub(outside), 0.5, 1));
      // blend in tone-mapped space (weights 1 / (1 + luma)): bright sky pixels don't swamp the leaves next to them
      const cur = sum.div(max(w, 1e-5));
      const wc = w.div(cur.x.add(cur.y).add(cur.z).div(3).add(1));
      const wh = wHist.div(clipped.x.add(clipped.y).add(clipped.z).div(3).add(1));
      const out = cur.mul(wc).add(clipped.mul(wh)).div(max(wc.add(wh), 1e-5));
      // (?taadebug=2: how far each pixel's history is fetched from, in pixels x 0.1: red x, green y)
      if (params.get('taadebug') === '2') return vec4(abs(prevUv.sub(screenUV).mul(screenSize)).mul(0.1), 0, 1);
      return vec4(clamp(dec(out), 0, 65000), wHist.add(w));
    })();
  }

  /**
   * The history at `uv`, Catmull-Rom filtered (5 bilinear taps): a plain bilinear lookup blurs a little more every
   * frame wherever things move (the leaves in the wind), and the trees went soft.
   */
  _catmullRom(uv: Vec2): Vec3 {
    const size = screenSize;
    const pos = uv.mul(size);
    const t1 = pos.sub(0.5).floor().add(0.5);
    const f = pos.sub(t1);
    const w0 = f.mul(f.mul(f.mul(-0.5).add(1)).sub(0.5));
    const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1);
    const w2 = f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5));
    const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5));
    const w12 = w1.add(w2);
    const t0 = t1.sub(1).div(size), t3 = t1.add(2).div(size), t12 = t1.add(w2.div(w12)).div(size);
    const tap = (x: Float, y: Float, w: Float): Vec3 => this.historyTex.sample(vec2(x, y)).rgb.mul(w);
    const sum = tap(t12.x, t0.y, w12.x.mul(w0.y))
      .add(tap(t0.x, t12.y, w0.x.mul(w12.y)))
      .add(tap(t12.x, t12.y, w12.x.mul(w12.y)))
      .add(tap(t3.x, t12.y, w3.x.mul(w12.y)))
      .add(tap(t12.x, t3.y, w12.x.mul(w3.y)));
    const wsum = w12.x.mul(w0.y).add(w0.x.mul(w12.y)).add(w12.x.mul(w12.y)).add(w3.x.mul(w12.y)).add(w12.x.mul(w3.y));
    return max(sum.div(wsum), vec3(0));
  }

  /**
   * Per frame, before anything is culled or drawn: jitters the camera's projection by this frame's sub-pixel offset
   * (the culling, the software rasterizer and the draws all see the same camera) and moves the dither pattern.
   * `width` x `height`: the scene's pixels.
   */
  jitter(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.u.sharpen.value = this.enabled ? Number(params.get('sharpen') ?? 0.25) : 0;
    this.u.off.value = this.enabled ? 0 : 1;
    if (!this.enabled) {
      ditherShift.value.set(0, 0);
      return;
    }
    this.renderer.getDrawingBufferSize(this.outSize);
    const ratio = this.outSize.x / width;
    const i = (this.frame % phasesOf(ratio)) + 1;
    const jx = (halton(i, 2) - 0.5) * this.spread, jy = (halton(i, 3) - 0.5) * this.spread;
    const e = camera.projectionMatrix.elements;
    e[8] += (jx * 2) / width;
    e[9] += (jy * 2) / height;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    // (the projection's x offset moves the image left by jx pixels, its y offset down by jy: the sample at a texel's
    // centre sees what was jx to its right and jy above it)
    this.u.jitterOff.value.set(jx, -jy);
    this.u.renderSize.value.set(width, height);
    this.u.ratio.value = ratio;
    // (a frame's samples are then 1 / (frames x ratio) of the result, on average: upscaled, an output pixel gets a
    // near sample only every ratio^2 frames, and 10 frames' worth shimmered on a phone at 3x, the forest from 9 km
    // and the canopy, still and turning; 30 halved it: canopy still 566 -> 209, turning 15679 -> 12526)
    if (ratio !== this.lastRatio) {
      this.lastRatio = ratio;
      this.u.maxWeight.value = (this.frames * Math.max(1, ratio) - 1) * meanWeight(ratio);
      this.u.kernel.value = -KERNEL / ratio;
    }
    // (interleaved gradient noise: a shift of 5.588 px per frame decorrelates consecutive patterns)
    const s = 5.588238 * (this.frame % 64);
    ditherShift.value.set(s, s);
  }

  /** After the scene is drawn: blends it into the history (at the canvas's size); the output pass then shows `outputTex`. */
  resolve(camera: THREE.Camera, viewer: THREE.Vector3): void {
    const r = this.renderer;
    if (!this.enabled) {
      this.outputTex.value = this.sceneRT.texture;
      return;
    }
    r.getDrawingBufferSize(this.outSize);
    const w = this.outSize.x, h = this.outSize.y;
    const src = this.history[this.frame % 2], dst = this.history[(this.frame + 1) % 2];
    for (const rt of this.history) if (rt.width !== w || rt.height !== h) {
      rt.setSize(w, h);
      this.reset = true;
    }
    const u = this.u;
    u.invViewProj.value.copy(this.viewProj).invert();
    u.prevViewProj.value.copy(this.reset ? this.viewProj : this.prevViewProjCPU);
    u.reproject.value.multiplyMatrices(u.prevViewProj.value, u.invViewProj.value);
    u.viewer.value.copy(viewer);
    u.prevViewer.value.copy(this.reset ? viewer : this.prevViewer);
    u.resetting.value = this.reset ? 1 : 0;
    this.historyTex.value = src.texture;
    r.setRenderTarget(dst);
    this.quad.render(r);
    r.setRenderTarget(null);
    this.outputTex.value = dst.texture;
    this.prevViewProjCPU.copy(this.viewProj);
    this.prevViewer.copy(viewer);
    this.reset = false;
    this.frame++;
  }
}
