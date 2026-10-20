// God rays: light shafts from the sun through the gaps in the canopy, in screen space (the classic radial blur).
// A half-resolution pass marches from each pixel towards the sun's position on screen and adds up the open sky it
// crosses (depth at the far plane), weighted by how close to the sun that sky is and decaying with the distance
// marched; the output pass adds the result, tinted like the sun, before tone mapping. Fixed cost (one pass of
// SAMPLES depth taps at a quarter of the pixels), no dependence on the shadow map's extent (three.js's GodraysNode
// marches the shadow map, which here covers only part of the view).
import * as THREE from 'three/webgpu';
import { Fn, Loop, uniform, texture, textureLoad, ivec2, vec2, vec3, vec4, float, int, screenUV, screenCoordinate, select, exp, max, length } from 'three/tsl';
import { ditherAt } from './nanite-lib/index.ts';
import type { Vec2, Vec3 } from './types.ts';

const params = new URLSearchParams(location.search);
const SAMPLES = 40;

export class GodRays {
  readonly renderer: THREE.WebGPURenderer;
  readonly sunDir: THREE.Vector3;
  enabled: boolean;
  readonly rt: THREE.RenderTarget;
  readonly u;
  readonly intensity: number;
  readonly decay: number;
  readonly quad: THREE.QuadMesh;
  /** The light it adds at `uv` (linear HDR, before the TAA resolve and tone mapping). */
  readonly at: (uv: Vec2) => Vec3;
  readonly _v = new THREE.Vector3();
  readonly _fwd = new THREE.Vector3();

  /** `depth`: the scene's (MSAA) depth texture; `sunDir`: unit vector towards the sun. */
  constructor(renderer: THREE.WebGPURenderer, depth: THREE.DepthTexture, sunDir: THREE.Vector3, { enabled = true } = {}) {
    this.renderer = renderer;
    this.sunDir = sunDir;
    this.enabled = enabled;
    this.rt = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.u = {
      sunUv: uniform(new THREE.Vector2(0.5, 0.5)),
      aspect: uniform(1),
      strength: uniform(0), // 0 when the sun is behind the camera or far off screen, else `intensity`
      depthSize: uniform(new THREE.Vector2(1, 1)),
    };
    this.intensity = Number(params.get('rays') ?? 1);
    this.decay = Number(params.get('raydecay') ?? 0.97);
    const falloff = Number(params.get('rayfall') ?? 2.5);
    const u = this.u;
    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = Fn(() => {
      const uv = screenUV;
      // march at most halfway across the screen: past that the shafts are faint and the samples sparse
      const toSun = u.sunUv.sub(uv);
      const span = length(toSun.mul(vec2(u.aspect, 1)));
      const step = toSun.mul(float(0.5).div(max(span, 0.5))).div(SAMPLES);
      // (each pixel starts its march at a random fraction of a step, moving every frame: TAA averages away the
      // stair-steps the fixed sample positions leave along the shafts)
      const sum = float(0).toVar(), w = float(1).toVar(), p = uv.add(step.mul(ditherAt(screenCoordinate.xy))).toVar();
      Loop(SAMPLES, () => {
        p.addAssign(step);
        const d = textureLoad(depth, ivec2(p.clamp(0, 0.9999).mul(u.depthSize)), int(0)).x;
        // open sky near the sun's disc glows (the halo the shafts carry); far from it, nothing
        const off = length(p.sub(u.sunUv).mul(vec2(u.aspect, 1)));
        sum.addAssign(select(d.greaterThanEqual(1), exp(off.mul(-6)), float(0)).mul(w));
        w.mulAssign(this.decay);
      });
      // (fading with the pixel's distance from the sun: the whole screen below a sun just out of view washed out)
      return vec4(vec3(sum.mul(u.strength).mul(exp(span.mul(-falloff))).div(SAMPLES * 0.4)), 1);
    })();
    this.quad = new THREE.QuadMesh(mat);
    const tex = texture(this.rt.texture);
    this.at = (uv) => tex.sample(uv).rgb.mul(vec3(1.0, 0.86, 0.66));
  }

  /** After the scene is drawn. */
  render(camera: THREE.Camera, width: number, height: number): void {
    const u = this.u;
    camera.getWorldDirection(this._fwd);
    const facing = this._fwd.dot(this.sunDir);
    const v = this._v.copy(camera.position).addScaledVector(this.sunDir, 1e5).project(camera);
    u.sunUv.value.set(v.x * 0.5 + 0.5, 0.5 - v.y * 0.5);
    // fade out as the sun leaves the screen (and turn off behind the camera)
    const off = Math.max(Math.abs(v.x), Math.abs(v.y));
    u.strength.value = this.enabled && facing > 0 ? this.intensity * THREE.MathUtils.smoothstep(1.6 - off, 0, 0.6) : 0;
    u.aspect.value = width / height;
    u.depthSize.value.set(width, height);
    const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1);
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    if (u.strength.value > 0) this.quad.render(r);
    else r.clear();
    r.setRenderTarget(null);
  }
}
