// Sky, fog, sun and the sun's shadow map (one map that follows the view), and the far-field shadow fade.
import * as THREE from 'three/webgpu';
import { Fn, float, max, abs, mix, positionWorld, cameraPosition, cubeTexture, fog, rangeFogFactor, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { heightAt } from './terrain.ts';
import { PHASE2_LAYER } from './nanite/constants.ts';

const params = new URLSearchParams(location.search);
const SHADOW_MAX = Number(params.get('shadowmax') ?? 6000); // largest half-extent of the shadow map (m)

export function createLighting(scene, { harness }) {
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
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'sunPosition', 'cloudCoverage', 'cloudDensity', 'cloudElevation'])
    sky2[k].value = sky[k].value.clone?.() ?? sky[k].value;
  sky2.cloudSpeed.value = 0;
  sky2.scale.setScalar(100);
  skyCapture.add(sky2);
  const skyCube = new THREE.CubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cubeCam = new THREE.CubeCamera(1, 1000, skyCube);
  const fogNear = uniform(400), fogFar = uniform(4000);
  const fogColour = (pos) => {
    const viewDir = pos.sub(cameraPosition).normalize();
    const horizonDir = vec3(viewDir.x, max(viewDir.y, 0.015), viewDir.z).normalize();
    return cubeTexture(skyCube.texture, horizonDir).level(2).rgb;
  };
  scene.fogNode = fog(fogColour(positionWorld), rangeFogFactor(fogNear, fogFar));

  const hemi = new THREE.HemisphereLight(0xbcd3ec, 0x4a4632, 1.3);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sun.castShadow = true;
  const smap = Number(params.get('smap') ?? 2048);
  sun.shadow.mapSize.set(smap, smap);
  // One shadow map that follows the view. Its half-extent grows with altitude (in steps, so texels don't crawl),
  // and receivers fade the shadow out towards its edge, so there's no hard "shadow stops here" line.
  let SH = 0;
  const sunBack = () => Math.max(800, SH * 1.2);
  function setShadowExtent(h) {
    if (h === SH) return;
    SH = h;
    // (depth range: the sun sits `sunBack` from the focus; the ground across the map spans about its width in depth)
    Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 2 * sunBack() });
    sun.shadow.camera.updateProjectionMatrix();
  }
  setShadowExtent(110);
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
  const makeFadeShadow = (far, pos = positionWorld) => Fn(([shadow]) => {
    const c = shadowMatrix.mul(vec4(pos, 1)).xy;
    const edge = max(abs(c.x.sub(0.5)), abs(c.y.sub(0.5))).mul(2);
    const fade = max(smoothstep(0.75, 0.97, edge), farEverywhere);
    return mix(shadow, mix(float(1), far, farShadowOn), fade);
  });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  sun.shadow.camera.layers.set(1); // the forest has dedicated (coarser, light-culled) shadow-caster meshes on layer 1
  scene.add(sun, sun.target);
  hemi.layers.enable(PHASE2_LAYER);
  sun.layers.enable(PHASE2_LAYER);

  /** Per frame: the shadow map centred on the ground the camera looks at (`gy`: ground height under the camera). */
  function follow(camera, gy, shift) {
    // shadow map: centred on the ground the camera looks at, extent from altitude
    const agl = Math.max(0, camera.position.y - gy);
    // (no lower cap than the view needs: at 1.8 km a 640 m map was a rectangle of real shadows in an evenly shaded
    // forest; the texels stay ~2 px at the nearest ground as the map grows with altitude)
    setShadowExtent(Math.min(SHADOW_MAX, 110 * Math.pow(1.25, Math.max(0, Math.ceil(Math.log(1 + agl / 40) / Math.log(1.25))))));
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const reach = dir.y < -0.05 ? Math.min(SH * 0.9, agl / -dir.y) : SH * 0.5;
    const focus = camera.position.clone().addScaledVector(dir, reach).add(shift);
    focus.y = heightAt(focus.x, focus.z);
    // snap in light space (the sun is diagonal: snapping world x/z doesn't stop shimmer)
    const texel = (2 * SH) / sun.shadow.mapSize.x;
    const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize();
    const ly = new THREE.Vector3().crossVectors(sunDir, lx);
    const fx = Math.round(focus.dot(lx) / texel) * texel, fy = Math.round(focus.dot(ly) / texel) * texel, fz = focus.dot(sunDir);
    focus.copy(lx).multiplyScalar(fx).addScaledVector(ly, fy).addScaledVector(sunDir, fz);
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(sunDir, sunBack());

    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
  }

  return { sky, sun, sunDir, hemi, fogNear, fogFar, fogColour, skyCapture, cubeCam, makeFadeShadow, treeFarShadow, farShadowOn, follow };
}
