// Sky, fog, sun and the sun's shadow map (one map that follows the view), and the far-field shadow fade.
import * as THREE from 'three/webgpu';
import { Fn, float, max, abs, mix, positionWorld, cameraPosition, cubeTexture, fog, rangeFogFactor, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { heightAt } from './terrain.ts';
import { PHASE2_LAYER } from './nanite-lib/index.ts';
import type { Float, Vec3 } from './types.ts';

const params = new URLSearchParams(location.search);
const SHADOW_MAX = Number(params.get('shadowmax') ?? 6000); // largest half-extent of the shadow map (m)

export function createLighting(scene: THREE.Scene, { harness, floatTargets = true }: { harness: boolean; floatTargets?: boolean }) {
  // sky + sun
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(215));
  const sky = new SkyMesh();
  sky.scale.setScalar(120000);
  sky.cloudCoverage.value = 0; // the real cloud deck (clouds.js) replaces the dome's painted clouds
  sky.turbidity.value = 4;
  sky.rayleigh.value = 1.2;
  sky.mieCoefficient.value = 0.004;
  sky.mieDirectionalG.value = 0.85;
  sky.sunPosition.value.copy(sunDir);
  sky.material.fog = false;
  if (harness) sky.cloudSpeed.value = 0; // still clouds: frame-to-frame comparisons only see the forest
  scene.add(sky);

  // Fog takes the sky's own colour in the view direction (from a small cube capture of the sky), so fully fogged
  // terrain and trees melt into the sky instead of meeting it at a grey band. Below the horizon it uses the horizon.
  const skyCapture = new THREE.Scene();
  const sky2 = new SkyMesh();
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'cloudCoverage', 'cloudDensity', 'cloudElevation'] as const)
    sky2[k].value = sky[k].value;
  sky2.sunPosition.value.copy(sky.sunPosition.value);
  sky2.cloudSpeed.value = 0;
  sky2.scale.setScalar(100);
  skyCapture.add(sky2);
  const skyCube = new THREE.CubeRenderTarget(128, { type: floatTargets ? THREE.HalfFloatType : THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cubeCam = new THREE.CubeCamera(1, 1000, skyCube);
  const fogNear = uniform(400), fogFar = uniform(4000);
  const fogColour = (pos: Vec3): Vec3 => {
    const viewDir = pos.sub(cameraPosition).normalize();
    const horizonDir = vec3(viewDir.x, max(viewDir.y, 0.015), viewDir.z).normalize();
    return cubeTexture(skyCube.texture, horizonDir).level(float(2)).rgb;
  };
  scene.fogNode = fog(fogColour(positionWorld), rangeFogFactor(fogNear, fogFar));

  const hemi = new THREE.HemisphereLight(0xbcd3ec, 0x4a4632, 1.3);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sun.castShadow = true;
  const smapParam = params.get('smap');
  sun.shadow.mapSize.set(2048, 2048);
  /**
   * The shadow map's side for a drawing buffer of `pixels` (`?smap=` fixes it): 2048 at 1080p (texels ~2 px on the
   * nearest ground), fewer for fewer pixels, a power of two from 512 to 2048. It was 2048 everywhere: a laptop's
   * integrated GPU at half resolution filled 8x more shadow texels than screen pixels (on the dev GPU at its settings
   * 42% of the frame), a phone's 30x.
   */
  // (a smaller map only once it's been wanted for SHRINK_MS: auto quality's resolution steps after a zoom halved it,
  // every shadow twice as coarse for a second or two, the user's "zooming in... changes shadows too much")
  const SHRINK_MS = 10000;
  let smallerSince = 0, fitted = false;
  function fitShadowMap(pixels: number): void {
    const n = smapParam ? Number(smapParam) : 2 ** Math.min(11, Math.max(9, Math.round(Math.log2(2048 * Math.sqrt(pixels / (1920 * 1080))))));
    const now = performance.now(), have = sun.shadow.mapSize.x;
    if (n < have && !smapParam && fitted) {
      smallerSince ||= now;
      if (now - smallerSince < SHRINK_MS) return;
    }
    smallerSince = 0;
    fitted = true; // (the first fit at once: a phone starts at 60% resolution)
    if (n !== have) sun.shadow.mapSize.set(n, n);
  }
  // One shadow map that follows the view. Its half-extent grows with altitude (in steps, so texels don't crawl),
  // and receivers fade the shadow out towards its edge, so there's no hard "shadow stops here" line.
  // SH: the half-extent across the sun (and the ground's along it); SV: the map's other half, up the sun's direction.
  // Seen from the sun, the ground along its azimuth is foreshortened to sin(elevation) (0.53): a square map spent half
  // its texels there on nothing. SV is the ground's SH that short, plus what stands above or below it (the relief
  // round the focus, the tallest trees and statues: cos(elevation) of each metre): ~1.7x finer texels looking down
  // (the user: shadows "1.5x longer" zoomed in, their thin ends lost in 0.8 m texels unzoomed).
  let SH = 0, SV = 0;
  const sunBack = () => Math.max(800, SH * 1.2);
  const sinE = Math.max(0.2, sunDir.y), cosE = Math.sqrt(1 - sinE * sinE);
  function setShadowExtent(h: number, rise: number): void {
    const v = Math.min(h, h * sinE + rise * cosE);
    if (h === SH && v === SV) return;
    (SH = h), (SV = v);
    // (depth range: the sun sits `sunBack` from the focus; the ground across the map spans about its width in depth)
    Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SV, bottom: -SV, near: 1, far: 2 * sunBack() });
    sun.shadow.camera.updateProjectionMatrix();
  }
  setShadowExtent(110, 110);
  const shadowMatrix = uniform(sun.shadow.matrix);
  // Beyond the shadow map, receivers fade to an *average* shadow instead of none: a constant canopy self-shadow
  // for trees and a forest-density darkening for the ground (and the impostors carry the same darkening). Fading
  // to fully lit made distant forest brighter than near forest, with a visible line where the map ends.
  const farShadowOn = uniform(1); // 0 when shadows are switched off
  const farEverywhere = uniform(params.get('farall') === '1' ? 1 : 0); // (debug: calibrate against the real map)
  const treeFarShadow = uniform(Number(params.get('treeshade') ?? 0.35));
  // (Impostors cast their shadow too, so the real map is used wherever it reaches: an average shadow where the trees
  // turned impostor changed visibly at the switch and with the zoom.)
  // (`pos`: the receiver's world position, for materials that compute their own, see softraster.js)
  const makeFadeShadow = (far: Float, pos: Vec3 = positionWorld) => Fn(([shadow]: [Float]) => {
    const c = shadowMatrix.mul(vec4(pos, 1)).xy;
    const edge = max(abs(c.x.sub(0.5)), abs(c.y.sub(0.5))).mul(2);
    const fade = max(smoothstep(0.75, 0.97, edge), farEverywhere);
    return mix(shadow, mix(float(1), far, farShadowOn), fade);
  });
  // Past this texel size (m) the map can't draw one tree's shadow (a crown is 5-8 m across): from high up the average
  // shadow takes over everywhere and the shadow pass is skipped (`?fartexel=`). A phone 8 km up spent ~30% of its GPU
  // time drawing ~800k impostor shadow quads into 23 m texels. It blends in from half that texel size (by the
  // altitude, not the map's stepped extent): the coarse map lets light through the crowns, the calibrated average is
  // 6-8/255 darker, a jump as you climbed.
  const FAR_TEXEL = Number(params.get('fartexel') ?? 5);
  let farForce = 0, farForced = 0; // (auto quality's last tier: the average shadow at any height, eased)
  let agl = 0, half = 110; // (half: the map's half-extent before its steps)
  const RISE = 80; // (m: the tallest above the ground, the Lucy scene's 20x statues; trees ~35 m: the map's height up the sun)
  /** Per frame, after follow(): the average shadow's share everywhere; true when it's all of it (skip the pass). */
  function shadowFarOnly(): boolean {
    const texel = (2 * half) / sun.shadow.mapSize.x;
    const t = Math.min(1, Math.max(0, (texel - FAR_TEXEL / 2) / (FAR_TEXEL / 2)));
    farForced += Math.sign(farForce - farForced) * Math.min(Math.abs(farForce - farForced), 1 / 90); // (~1.5 s at 60 fps)
    const b = t * t * (3 - 2 * t);
    farEverywhere.value = params.get('farall') === '1' ? 1 : Math.max(b, farForced * farForced * (3 - 2 * farForced));
    return farEverywhere.value >= 1;
  }
  // The biases (follow) are in texels: fixed at 0.6 m and ~0.64 m of depth, sized for metre texels, near the ground
  // (0.1 m texels) they cut the first metre of every shadow, a statue standing in a lit ring "as if hanging in the
  // air" (the user). `?shadowbias=` scales both.
  const BIAS = Number(params.get('shadowbias') ?? 1);
  sun.shadow.camera.layers.set(1); // the forest has dedicated (coarser, light-culled) shadow-caster meshes on layer 1
  scene.add(sun, sun.target);
  hemi.layers.enable(PHASE2_LAYER);
  sun.layers.enable(PHASE2_LAYER);

  /**
   * The ground the view sees (zoomed too), as the plane at `gy` under its four corners: their middle and the furthest
   * of them from it; null when a corner sees the sky or ground further than `max` (the map then sized by altitude).
   */
  function groundSeen(camera: THREE.PerspectiveCamera, gy: number, max: number): { centre: THREE.Vector3; r: number } | null {
    const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), th = tv * camera.aspect;
    const e = camera.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]), up = new THREE.Vector3(e[4], e[5], e[6]), fwd = new THREE.Vector3(-e[8], -e[9], -e[10]);
    const h = camera.position.y - gy, hits: THREE.Vector3[] = [];
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const d = fwd.clone().addScaledVector(right, x * th).addScaledVector(up, y * tv);
      if (d.y > -1e-3 || h <= 0) return null;
      const p = camera.position.clone().addScaledVector(d, h / -d.y);
      if (Math.hypot(p.x - camera.position.x, p.z - camera.position.z) > max) return null;
      hits.push(p);
    }
    const centre = hits.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(0.25);
    return { centre, r: Math.max(...hits.map((p) => Math.hypot(p.x - centre.x, p.z - centre.z))) };
  }

  /** Per frame: the shadow map centred on the ground the camera looks at (`gy`: ground height under the camera). */
  function follow(camera: THREE.Camera, gy: number, shift: THREE.Vector3): void {
    // shadow map: centred on the ground the camera looks at, extent from altitude
    agl = Math.max(0, camera.position.y - gy);
    // (no lower cap than the view needs: at 1.8 km a 640 m map was a rectangle of real shadows in an evenly shaded
    // forest; the texels stay ~2 px at the nearest ground as the map grows with altitude)
    const high = Math.min(SHADOW_MAX, 110 * (1 + agl / 40));
    // looking down, only the ground in view: the square round it (its corners inside the edge fade). Sized for views
    // to the horizon, looking straight down from 400 m a texel was 1.25 m, ~4 px, and a statue's shadow (~1 m wide)
    // faded out from ~200 m up (the user). The zoomed view's ground: by the unzoomed one, its texels were 5x as big
    // on screen and small statues had no shadow (the user). The casters' LOD stays as unzoomed (renderer.ts): at the
    // zoomed one Lucy's shadows were 1M -> 27-34M triangles (her errors stall at 1.76 m, then the 70-triangle root),
    // +2-3.5 ms, and they look the same in the finer texels. The map steps as the zoom eases in, not after.
    const seen = groundSeen(camera as THREE.PerspectiveCamera, gy, high);
    half = seen ? Math.max(110, seen.r / 0.75) : high;
    const ext = Math.min(SHADOW_MAX, 110 * Math.pow(1.25, Math.max(0, Math.ceil(Math.log(half / 110) / Math.log(1.25) - 1e-9))));
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const reach = dir.y < -0.05 ? Math.min(ext * 0.9, agl / -dir.y) : ext * 0.5;
    const focus = (seen ? seen.centre.clone() : camera.position.clone().addScaledVector(dir, reach)).add(shift);
    focus.y = heightAt(focus.x, focus.z);
    // (the relief over the map's ground, on a 5x5 grid, plus RISE for what stands on it; in 10 m steps, so the map's
    // texels don't change size with every metre the focus moves)
    let relief = 0;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) relief = Math.max(relief, Math.abs(heightAt(focus.x + (i * ext) / 2, focus.z + (j * ext) / 2) - focus.y));
    setShadowExtent(ext, Math.ceil((relief + RISE) / 10) * 10);
    const groundTexel = Math.max(2 * SH, (2 * SV) / sinE) / sun.shadow.mapSize.x; // (m on the ground: the coarser way)
    sun.shadow.normalBias = BIAS * groundTexel;
    sun.shadow.bias = (-BIAS * groundTexel * sinE) / (2 * sunBack()); // (in the depth range's units: along the sun)
    // snap in light space (the sun is diagonal: snapping world x/z doesn't stop shimmer)
    const tx = (2 * SH) / sun.shadow.mapSize.x, ty = (2 * SV) / sun.shadow.mapSize.y;
    const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize();
    const ly = new THREE.Vector3().crossVectors(sunDir, lx);
    const fx = Math.round(focus.dot(lx) / tx) * tx, fy = Math.round(focus.dot(ly) / ty) * ty, fz = focus.dot(sunDir);
    focus.copy(lx).multiplyScalar(fx).addScaledVector(ly, fy).addScaledVector(sunDir, fz);
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(sunDir, sunBack());

    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
  }

  return { sky, sun, sunDir, hemi, fogNear, fogFar, fogColour, skyCapture, cubeCam, makeFadeShadow, treeFarShadow, farShadowOn, follow, fitShadowMap, shadowFarOnly, forceFarShadow: (on: boolean): void => void (farForce = on ? 1 : 0) };
}
