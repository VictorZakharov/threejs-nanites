// Temporal anti-aliasing: the camera is shifted by a different sub-pixel offset every frame (Halton 2,3), and a
// resolve pass blends each new frame into a history: the previous result, looked up where this pixel was a frame
// ago. Small trees whose leaves and twigs are thinner than a pixel otherwise shimmer as the camera moves (they hit
// or miss pixel centres), which made the band where trees turn into steady impostors visible in motion.
//
// Where a pixel was: rebuilt from the depth buffer and last frame's camera (static scenery). Wind and the impostors
// turning with the camera are small per frame; the history is clipped to the colour range of the pixel's 3x3
// neighbourhood, which keeps them (and anything newly uncovered) from ghosting. The planet's curvature moves with
// the viewer (see planet.js), so the reprojection undoes this frame's drop and applies last frame's.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, texture, textureLoad, ivec2, int, vec2, vec3, vec4, float, max, min, mix, select, clamp, dot, sqrt,
  screenUV, screenCoordinate, screenSize, abs,
} from 'three/tsl';
import { PLANET_RADIUS } from './planet.js';
import { ditherShift } from './nanite/shading.js';

const halton = (i, b) => {
  let f = 1, r = 0;
  for (; i > 0; i = Math.floor(i / b)) r += (f /= b) * (i % b);
  return r;
};
const params = new URLSearchParams(location.search);
// the jitter's spread (pixels; 1 = the whole pixel): MSAA already smooths geometric edges, the jitter is for what's
// smaller than its samples, and a narrower spread keeps the image sharper
const SPREAD = Number(params.get('taajitter') ?? 0.5);
const JITTER = Array.from({ length: 8 }, (_, i) => [(halton(i + 1, 2) - 0.5) * SPREAD, (halton(i + 1, 3) - 0.5) * SPREAD]);

/** Colour <-> YCoCg (the neighbourhood box is tighter around foliage greens in it than in RGB). */
const toYCoCg = (c) => vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25)));
const toRGB = (y) => vec3(y.x.add(y.y).sub(y.z), y.x.add(y.z), y.x.sub(y.y).sub(y.z));

export class TAA {
  /** `sceneRT`: the MSAA scene target (colour + depth texture), `samples` its sample count. */
  constructor(renderer, sceneRT, samples, { enabled = true, feedback = Number(params.get('taafeedback') ?? 0.1) } = {}) {
    this.renderer = renderer;
    this.sceneRT = sceneRT;
    this.enabled = enabled;
    this.frame = 0;
    this.reset = true;
    const make = () => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.history = [make(), make()];
    this.u = {
      invViewProj: uniform(new THREE.Matrix4()), // this frame, unjittered
      prevViewProj: uniform(new THREE.Matrix4()), // last frame, unjittered
      reproject: uniform(new THREE.Matrix4()), // prevViewProj x invViewProj (this frame's clip -> last frame's)
      viewer: uniform(new THREE.Vector3()),
      prevViewer: uniform(new THREE.Vector3()),
      feedback: uniform(feedback), // share of the new frame
      resetting: uniform(1),
      sharpen: uniform(Number(params.get('sharpen') ?? 0.25)), // the output's unsharp mask (TAA softens a little)
    };
    this.viewProj = new THREE.Matrix4();
    this.prevViewProjCPU = new THREE.Matrix4();
    this.prevViewer = new THREE.Vector3();
    this.historyTex = texture(this.history[0].texture);
    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = this._resolveNode(sceneRT, samples);
    mat.toneMapped = false;
    this.quad = new THREE.QuadMesh(mat);
    /** What the output pass shows: the latest resolved frame (or the scene itself with TAA off). */
    this.outputTex = texture(sceneRT.texture);
    // ... through a light unsharp mask (4 neighbours) when TAA is on
    const px = vec2(1).div(screenSize);
    const c = this.outputTex.rgb;
    const ring = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, y]) => this.outputTex.sample(screenUV.add(px.mul(vec2(x, y)))).rgb);
    const avg = ring.reduce((a, b) => a.add(b)).mul(0.25);
    this.displayNode = max(c.add(c.sub(avg).mul(this.u.sharpen)), vec3(0));
    // (?taadebug=1: shows the trees' wind motion instead, x red / y green, x200)
    if (params.get('taadebug') === '2') this.displayNode = this.outputTex.rgb;
    if (params.get('taadebug') === '1') this.displayNode = abs(textureLoad(sceneRT.textures[1], ivec2(screenCoordinate.xy)).xyz).mul(200);
  }

  _resolveNode(sceneRT, samples) {
    const u = this.u;
    const colour = sceneRT.texture, depth = sceneRT.depthTexture, wind = sceneRT.textures[1];
    const invTwoR = 1 / (2 * PLANET_RADIUS);
    return Fn(() => {
      const p = ivec2(screenCoordinate.xy);
      const cur = textureLoad(colour, p).rgb.toVar();
      // neighbourhood: colour mean and spread (variance clipping box, in YCoCg) and the nearest depth (dilated:
      // thin twigs reproject with the depth of what they are, not of the sky behind them)
      const m1 = vec3(0).toVar(), m2 = vec3(0).toVar();
      const zMin = float(1).toVar();
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const q = p.add(ivec2(dx, dy));
          const c = toYCoCg(textureLoad(colour, q).rgb);
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
      const ndc = vec4(screenUV.x.mul(2).sub(1), screenUV.y.mul(-2).add(1), zMin, 1);
      const w4 = u.invViewProj.mul(ndc);
      const world = w4.xyz.div(w4.w);
      const drop = (pos, v) => {
        const dx = pos.x.sub(v.x), dz = pos.z.sub(v.z);
        return dx.mul(dx).add(dz.mul(dz)).mul(invTwoR);
      };
      // (the planet's curve moves with the viewer: undo this frame's drop, apply last frame's; small, so the
      // imprecise world position is good enough for it)
      const lift = drop(world, u.viewer).sub(drop(world, u.prevViewer)).mul(w4.w);
      const prevClip = u.reproject.mul(ndc).add(u.prevViewProj.mul(vec4(0, lift, 0, 0)));
      // (minus the trees' own motion in the wind: depth only knows where the scenery was)
      const prevUv = vec2(prevClip.x.div(prevClip.w).mul(0.5).add(0.5), prevClip.y.div(prevClip.w).mul(-0.5).add(0.5))
        .sub(textureLoad(wind, p).xy);
      const onScreen = prevUv.x.greaterThanEqual(0).and(prevUv.x.lessThanEqual(1)).and(prevUv.y.greaterThanEqual(0)).and(prevUv.y.lessThanEqual(1));
      // history, clipped towards the mean into the box (clipping, not clamping: no colour shift at the box corners)
      const hist = toYCoCg(this._catmullRom(prevUv));
      const d = hist.sub(mean);
      const ext = max(boxMax.sub(mean), vec3(1e-4));
      const t = max(max(abs(d.x).div(ext.x), abs(d.y).div(ext.y)), abs(d.z).div(ext.z));
      const clipped = toRGB(select(t.greaterThan(1), mean.add(d.div(t)), hist));
      // blend in tone-mapped space (weights 1 / (1 + luma)): bright sky pixels don't swamp the leaves next to them
      const a = select(onScreen.and(u.resetting.equal(0)), u.feedback, float(1));
      const wc = a.div(cur.x.add(cur.y).add(cur.z).div(3).add(1));
      const wh = a.oneMinus().div(clipped.x.add(clipped.y).add(clipped.z).div(3).add(1));
      const out = cur.mul(wc).add(clipped.mul(wh)).div(max(wc.add(wh), 1e-5));
      // (?taadebug=2: how far each pixel's history is fetched from, in pixels x 0.1: red x, green y)
      if (params.get('taadebug') === '2') return vec4(abs(prevUv.sub(screenUV).mul(screenSize)).mul(0.1), 0, 1);
      return vec4(clamp(out, 0, 65000), 1);
    })();
  }

  /**
   * The history at `uv`, Catmull-Rom filtered (5 bilinear taps): a plain bilinear lookup blurs a little more every
   * frame wherever things move (the leaves in the wind), and the trees went soft.
   */
  _catmullRom(uv) {
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
    const tap = (x, y, w) => this.historyTex.sample(vec2(x, y)).rgb.mul(w);
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
   */
  jitter(camera, width, height) {
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.u.sharpen.value = this.enabled ? Number(params.get('sharpen') ?? 0.25) : 0;
    if (!this.enabled) {
      ditherShift.value.set(0, 0);
      return;
    }
    const [jx, jy] = JITTER[this.frame % JITTER.length];
    const e = camera.projectionMatrix.elements;
    e[8] += (jx * 2) / width;
    e[9] += (jy * 2) / height;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    // (interleaved gradient noise: a shift of 5.588 px per frame decorrelates consecutive patterns)
    const s = 5.588238 * (this.frame % 64);
    ditherShift.value.set(s, s);
  }

  /** After the scene is drawn: blends it into the history; the output pass then shows `outputTex`. */
  resolve(camera, viewer) {
    const r = this.renderer;
    const w = this.sceneRT.width, h = this.sceneRT.height;
    if (!this.enabled) {
      this.outputTex.value = this.sceneRT.texture;
      return;
    }
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
