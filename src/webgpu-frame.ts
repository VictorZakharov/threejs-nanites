// The WebGPU mode's frame (src/webgpu-start.ts): the camera kept over the world, what follows it (clouds, grass,
// litter, the overlays, fog, the shadow map), the culling, then the scene in two phases (the trees visible last frame,
// then occlusion and the rest), god rays, the TAA resolve and the output.
import * as THREE from 'three/webgpu';
import type { mrt } from 'three/tsl';
import { heightAt, terrainForAltitude } from './terrain.ts';
import { PHASE2_LAYER } from './nanite-lib/index.ts';
import { mipBias } from './nanite-lib/index.ts';
import { viewerPos, detailPos, detailShift } from './planet.ts';
import { MAX_ALTITUDE, forestRadius } from './placement.ts';
import type { NaniteForest } from './forest/forest.ts';
import type { FlyControls } from './controls.ts';
import type { TouchControls } from './touch.ts';
import type { createLighting } from './lighting.ts';
import type { createClouds } from './clouds.ts';
import type { createGrass } from './grass.ts';
import type { setupGround } from './ground/setup.ts';
import type { createWaypoint } from './waypoint.ts';
import type { createCompass } from './compass.ts';
import type { createMusic } from './music.ts';
import type { createResolution } from './resolution.ts';
import type { TAA } from './taa.ts';
import type { GodRays } from './godrays.ts';
import type { DemoState } from './harness-api.ts';

const params = new URLSearchParams(location.search);
const SW_ALTITUDE = Number(params.get('swalt') ?? 25); // m above the ground (?swalt=0: the software rasterizer everywhere)
const SPLAT_ALTITUDE = Number(params.get('splatalt') ?? 2000); // m above the ground: impostors splatted (src/nanite-lib/gpu/splats.ts)
// occlusion culling below this (m above the ground; ?occalt=): 260 m up it cost 0.24 ms, 8.8 km up 0.4, a phone 9%
const OCC_ALTITUDE = Number(params.get('occalt') ?? 150);

export interface FrameContext {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: FlyControls;
  touch: TouchControls | null;
  demo: DemoState;
  TREE_COUNT: number;
  terrain: THREE.Group;
  forest: NaniteForest;
  clouds: ReturnType<typeof createClouds>;
  grass: ReturnType<typeof createGrass>;
  litter: ReturnType<typeof setupGround>['litter'];
  lighting: ReturnType<typeof createLighting>;
  waypoint: ReturnType<typeof createWaypoint>;
  compass: ReturnType<typeof createCompass>;
  music: ReturnType<typeof createMusic>;
  res: ReturnType<typeof createResolution>;
  size: THREE.Vector2;
  sceneRT: THREE.RenderTarget;
  sceneMRT: ReturnType<typeof mrt>;
  taa: TAA;
  rays: GodRays;
  output: THREE.RenderPipeline;
  typeMasks: (on: boolean) => void;
  fitToWindow: () => void;
  shadowsOn: () => boolean;
}

/** The frame function: `frame(dt)` advances the world by dt seconds and draws it. */
export function createFrame(c: FrameContext): (dt: number) => void {
  const { renderer, scene, camera, controls, touch, demo, TREE_COUNT, terrain, forest, clouds, grass, litter, waypoint, compass, music, res, size, sceneRT, sceneMRT, taa, rays, output, typeMasks, fitToWindow, shadowsOn } = c;
  const { sun, fogNear, fogFar, follow, fitShadowMap, shadowFarOnly } = c.lighting;
  let time = 0;
  return function frame(dt: number): void {
    fitToWindow();
    time += dt;
    touch?.update();
    controls.update(dt);
    // stay above the ground
    const gy = heightAt(camera.position.x, camera.position.z) + 0.6;
    if (camera.position.y < gy) camera.position.y = gy;
    // stay over the world: below the edge of space, and over the forest's land
    camera.position.y = Math.min(camera.position.y, MAX_ALTITUDE);
    const lim = forestRadius(TREE_COUNT) * 2;
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -lim, lim);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, -lim, lim);
    viewerPos.value.copy(camera.position);
    detailPos.value.copy(camera.position).add(detailShift);
    clouds.update(time, camera);
    grass.update(camera);
    litter.update(camera.position, camera.position.y - heightAt(camera.position.x, camera.position.z));
    camera.updateMatrixWorld();
    waypoint.update(camera);
    compass.update(camera, controls.walking);
    taa.jitter(camera, size.x, size.y); // (this frame's sub-pixel offset, before anything is culled or drawn)
    mipBias.value = taa.enabled ? -Math.log2(res.ratio()) : 0; // (textures for the output's pixels: the TAA upscales)

    // view distance: the higher you fly, the further you see (fog thins), up to just inside the terrain's edge
    const altitude = Math.max(0, camera.position.y - gy);
    music.setAltitude(altitude); // (birdsong: fades out as you climb)
    terrainForAltitude(terrain, altitude); // (coarser ground from high up)
    // the software rasterizer only from SW_ALTITUDE up (down to 70% of it: no flipping at one height; see sw.idle)
    if (SW_ALTITUDE > 0) forest.sw.idle = altitude < (forest.sw.idle ? SW_ALTITUDE : SW_ALTITUDE * 0.7);
    forest.splats.idle = altitude < (forest.splats.idle ? SPLAT_ALTITUDE : SPLAT_ALTITUDE * 0.7); // (likewise)
    // occlusion culling only up to OCC_ALTITUDE (to 130% of it): from above little hides anything and its passes cost
    forest.u.occlusion.value = forest.occlusionOn && altitude < OCC_ALTITUDE * (forest.u.occlusion.value ? 1.3 : 1) ? 1 : 0;
    fogFar.value = Math.min(70000, 4000 + altitude * 14);
    fogNear.value = Math.min(6000, 400 + altitude * 3);
    typeMasks(forest.u.debug.value === 4); // (debug 4: src/type-masks.ts)
    forest.u.maxDist.value = fogFar.value;

    fitShadowMap(size.x * size.y); // (before follow: it snaps the map to its texels)
    follow(camera, gy, demo.shadowShift);
    // (from high up the average shadow everywhere, no shadow pass: lighting.ts FAR_TEXEL)
    const castShadows = shadowFarOnly() ? false : shadowsOn();
    sun.shadow.autoUpdate = castShadows;

    forest.update(camera, size, time, castShadows ? sun.shadow.camera : null);
    // phase 1: terrain, sky and the trees visible last frame (+ the shadow map)
    renderer.setRenderTarget(sceneRT);
    renderer.setMRT(sceneMRT);
    camera.layers.set(0);
    renderer.render(scene, camera);
    // phase 2: HZB from that depth, cull the rest and the impostors against it, draw what's visible (+ the clouds)
    forest.occlusion(camera, size.x, size.y);
    forest.rasterize(camera, size.x, size.y); // (the tiny clusters both phases listed, into the visibility buffer)
    const autoClear = renderer.autoClear, shadowAuto = sun.shadow.autoUpdate;
    renderer.autoClear = false;
    sun.shadow.autoUpdate = false;
    camera.layers.set(PHASE2_LAYER);
    renderer.render(scene, camera);
    camera.layers.set(0);
    sun.shadow.autoUpdate = shadowAuto;
    renderer.autoClear = autoClear;
    renderer.setMRT(null);
    rays.render(camera, size.x, size.y);
    taa.resolve(camera, camera.position);
    renderer.setRenderTarget(null);
    output.render();
  };
}
