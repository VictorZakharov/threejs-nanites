// The reduced WebGL 2 mode (issue #39): where there's no WebGPU (Firefox on Android), after the loading screen's
// warning. three's WebGPURenderer on its WebGL 2 backend draws the same world, terrain, sky, clouds and forest floor,
// with the forest of src/webgl/forest.ts (no compute: no GPU culling, occlusion, software rasterizer or splats), no
// grass, no TAA, upscaling or god rays, and a resolution steered by the frame time. Built from the same loading work
// as main.ts (its workers, the trees' DAGs, the planting).
import * as THREE from 'three/webgpu';
import { Fn, attribute, float, mix } from 'three/tsl';
import { heightAt, terrainForAltitude } from '../terrain.ts';
import { setupGround } from '../ground/setup.ts';
import { VARIANTS, type BuiltTree } from '../trees.ts';
import { makeLeafAlpha } from '../nanite/shading.ts';
import { bakeImpostors, createAtlas, impostorCoverage, IMPOSTOR_CUT } from '../impostors.ts';
import { viewerPos, detailPos, detailShift } from '../planet.ts';
import { createClouds } from '../clouds.ts';
import { FlyControls } from '../controls.ts';
import { TouchControls, isTouchDevice } from '../touch.ts';
import { arrayTexture } from '../textures.ts';
import { MAX_ALTITUDE, forestRadius, forestDensity, type TreeInstances } from '../placement.ts';
import { createLighting } from '../lighting.ts';
import { createMusic } from '../music.ts';
import { asReceivedShadow } from '../three-gaps.ts';
import { createWebGLForest } from './forest.ts';
import { installWebGLHarness } from './harness.ts';
import { createWebGLHud } from './hud.ts';
import { runLoop } from './harness.ts';
import { createMenu } from '../menu.ts';
import { createWaypoint } from '../waypoint.ts';
import { createCompass } from '../compass.ts';
import type { AutoQuality } from '../hud.ts';
import type { LoadingScreen } from '../loading.ts';
import type { DemoState } from '../harness-api.ts';
import type { FloorMaps } from '../ground/floor.ts';
import type { LayerData } from '../texture-pixels.ts';
import type { Float } from '../types.ts';

/** The warning's second line (the loading screen's error panel, with a Continue button). */
export const WEBGL_HINT = 'Nanite Forest is built for WebGPU: Chrome or Edge on desktop and Android, Safari or desktop Firefox where they have it (not Firefox on Android yet). Without it, it can run in a reduced WebGL mode: simpler trees, no grass, and it may look different or be slow.';

export interface WebGLStart {
  ui: LoadingScreen;
  demo: DemoState;
  params: URLSearchParams;
  harness: boolean;
  trees: number;
  terrainSize: number;
  barkTypes: string[];
  leafTypes: string[];
  t0: number;
  barkLayers: Promise<LayerData>[];
  leafLayers: Promise<LayerData>[];
  floorMaps: FloorMaps;
  planting: Promise<TreeInstances>;
  growing: Promise<BuiltTree[]>;
  terrainReady: Promise<THREE.Group>;
}

export async function startWebGL(o: WebGLStart): Promise<void> {
  const { ui, demo, params, harness } = o;
  await ui.update(0.02, 'Starting WebGL 2');
  const touch0 = isTouchDevice(params);
  const renderer = new THREE.WebGPURenderer({ forceWebGL: true, antialias: true, powerPreference: 'high-performance' });
  await renderer.init();
  const maxPr = Math.min(window.devicePixelRatio, touch0 ? 1.25 : 1.5); // (the resolution's 100%: auto.scale 1)
  renderer.setPixelRatio(touch0 ? Math.min(maxPr, 1) : maxPr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = params.get('shadows') !== '0';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(renderer.domElement);
  const gl = (renderer.backend as unknown as { gl?: WebGL2RenderingContext }).gl;
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const adapterName = String((gl && (info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))) ?? 'unknown GPU');
  ui.note(`WebGL 2: ${adapterName}, ${gl?.getParameter(gl.VERSION) ?? '?'}, max texture ${gl?.getParameter(gl.MAX_TEXTURE_SIZE) ?? '?'}`);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.3, 150000);
  const { sky, sun, fogNear, fogFar, skyCapture, cubeCam, makeFadeShadow, treeFarShadow, farShadowOn, follow, fitShadowMap } = createLighting(scene, { harness });
  sky.renderOrder = 2;
  const clouds = createClouds();
  scene.add(clouds.group);
  clouds.group.visible = params.get('clouds') !== '0';

  await ui.update(0.04, 'Raising hills, sky and sun');
  const terrain = await o.terrainReady;
  scene.add(terrain);
  terrain.traverse((obj) => (obj.renderOrder = 1));
  const { cover, litter, near: nearGround, floor: floorMat } = setupGround(terrain, o.floorMaps, forestRadius(o.trees), (far) => asReceivedShadow(makeFadeShadow(far)));

  const trees = await o.growing;
  await ui.update(0.77, 'Pressing leaves and bark into texture arrays');
  const [barkTex, leafTex] = await Promise.all([arrayTexture(o.barkLayers, 1024), arrayTexture(o.leafLayers, 1024)]);
  barkTex.colorSpace = leafTex.colorSpace = THREE.SRGBColorSpace;
  leafTex.wrapS = leafTex.wrapT = THREE.ClampToEdgeWrapping;
  await ui.update(0.8, `Scattering ${o.trees.toLocaleString()} trees`);
  const instances = await o.planting;
  const covered = forestDensity(instances, cover);
  litter.plant(instances);

  let ts = performance.now();
  const lap = (label: string): void => {
    ui.note(`${label} (${Math.round(performance.now() - ts)} ms)`);
    ts = performance.now();
  };
  await ui.update(0.82, 'Baking far-field impostors and the sky');
  cubeCam.update(renderer, skyCapture);
  const atlas = createAtlas(VARIANTS.length);
  const barkLayer = VARIANTS.map((v) => o.barkTypes.indexOf(v.bark)), leafLayer = VARIANTS.map((v) => o.leafTypes.indexOf(v.leaf));
  bakeImpostors(renderer, atlas, trees, { bark: barkTex, leaf: leafTex, barkLayers: barkLayer, leafLayers: leafLayer, leafAlpha: makeLeafAlpha(leafTex, attribute('uv', 'vec2')) }, 20);
  lap('Impostors baked');
  await impostorCoverage(renderer, atlas, IMPOSTOR_CUT).catch((e) => ui.note(`Impostor coverage skipped: ${e}`));
  lap('Impostor coverage');
  const impFade = makeFadeShadow(treeFarShadow);
  const forest = createWebGLForest(trees, instances, { bark: barkTex, leaf: leafTex, barkLayer, leafLayer }, atlas, {
    treeShadow: asReceivedShadow(makeFadeShadow(treeFarShadow)),
    impShadow: asReceivedShadow(Fn(([shadow]: [Float]) => impFade(shadow.mul(mix(float(1), treeFarShadow, farShadowOn))))),
  });
  scene.add(forest.group);
  lap('Forest meshes');
  await covered;

  const controls = new FlyControls(camera, renderer.domElement);
  camera.position.set(20, heightAt(20, 40) + 1.8, 40);
  controls.yaw = THREE.MathUtils.degToRad(30);
  controls.pitch = THREE.MathUtils.degToRad(4);
  const touch = (harness ? params.get('touch') === '1' : touch0) ? new TouchControls(controls, renderer.domElement) : null;
  controls.touchMode = Boolean(touch);
  controls.groundAt = heightAt;
  controls.walkEnabled = !harness || params.get('walk') === '1';
  controls.walking = controls.walkEnabled;
  const music = createMusic(params, harness);
  demo.music = music;

  // quality: the resolution (auto.scale of maxPr) and the near trees' detail (`tau`: forest.setDetail), the menu's
  // presets; auto quality steers the resolution by the frame time (no GPU timers here), down to half over the budget
  const budget = Number(params.get('budget') ?? (touch0 ? 33 : 17)); // ms a frame
  const auto: AutoQuality = { on: params.get('auto') !== '0' && !harness, budget, maxTau: 8, scale: renderer.getPixelRatio() / maxPr, gpuMs: 0, busy: false };
  const tau = { value: 1 };
  const setScale = (s: number): void => {
    auto.trials?.push(`${(performance.now() / 1000).toFixed(2)} s: ${auto.scale.toFixed(2)} -> ${s.toFixed(2)} (median frame ${median.toFixed(1)} ms)`);
    auto.scale = s;
    renderer.setPixelRatio(maxPr * s);
  };
  // By the median frame of each second, not an eased mean: one slow frame (a shader compile, the floor coming in, the
  // GPU catching up as the loop starts: 250-350 ms) pushed the mean over the budget, and the resolution stepped
  // down and back up twice in the first seconds, each a resize the user saw as a flicker. Nothing in the first 3 s
  // or 2 s after a step (a resize is a slow frame itself); up only if the larger size should stay under 85%.
  // A step down is a trial: if it didn't make frames 10% faster (the frame time was the CPU's or the display's, not
  // the pixels'), it goes back and the resolution holds for 30 s (as auto-quality.ts on WebGPU).
  let detail = tau.value, hold = 3, median = 0, span = 0, times: number[] = [];
  let trial: { from: number; before: number } | null = null;
  const steer = (dt: number): void => {
    if (tau.value !== detail) forest.setDetail((detail = tau.value)); // (the menu, or the [ ] keys)
    if ((hold -= dt) > 0) return void ((times = []), (span = 0)); // (the frames held off don't count)
    times.push(dt * 1000);
    if ((span += dt) < 1) return;
    median = [...times].sort((x, y) => x - y)[times.length >> 1];
    auto.frameMs = median;
    times = [];
    span = 0;
    if (!auto.on) return void (trial = null);
    const s = auto.scale;
    if (trial) {
      const failed = median > trial.before * 0.9;
      if (failed) auto.trials?.push(`step down saved ${Math.round((1 - median / trial.before) * 100)}%: back, held 30 s`);
      if (failed) (setScale(trial.from), (hold = 30));
      trial = null;
      if (failed) return;
    }
    const down = median > budget * 1.15 ? Math.max(0.5, s * 0.85) : s;
    const up = Math.min(1, s * 1.1), upCost = median * (up / s) ** 2; // (the cost goes with the pixels)
    const next = down < s ? down : median < budget * 0.7 && upCost < budget * 0.85 ? up : s;
    if (Math.abs(next - s) > 0.01) (next < s && (trial = { from: s, before: median }), setScale(next), (hold = 2));
  };
  // shadows off: no pass and no light lost (switching the shadow map off would recompile every shader)
  let shadowsOn = renderer.shadowMap.enabled;
  const setShadows = (on: boolean): void => {
    shadowsOn = on;
    sun.shadow.intensity = on ? 1 : 0;
    farShadowOn.value = on ? 1 : 0;
    sun.shadow.autoUpdate = on;
    sun.shadow.needsUpdate = true;
  };

  let time = 0, frameTris = 0;
  const waypoint = createWaypoint(harness && params.get('waypoint') !== '1'); // (to the plaza; as main.ts)
  const compass = createCompass(waypoint.target, harness && params.get('waypoint') !== '1');
  const size = new THREE.Vector2();
  function frame(dt: number): void {
    if (renderer.domElement.clientWidth !== window.innerWidth || renderer.domElement.clientHeight !== window.innerHeight) {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
    time += dt;
    touch?.update();
    controls.update(dt);
    const gy = heightAt(camera.position.x, camera.position.z) + 0.6;
    if (camera.position.y < gy) camera.position.y = gy;
    camera.position.y = Math.min(camera.position.y, MAX_ALTITUDE);
    const lim = forestRadius(o.trees) * 2;
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -lim, lim);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, -lim, lim);
    viewerPos.value.copy(camera.position);
    detailPos.value.copy(camera.position).add(detailShift);
    clouds.update(time, camera);
    litter.update(camera.position, camera.position.y - gy);
    camera.updateMatrixWorld();
    waypoint.update(camera);
    compass.update(camera, controls.walking);
    const altitude = Math.max(0, camera.position.y - gy);
    music.setAltitude(altitude);
    terrainForAltitude(terrain, altitude);
    fogFar.value = Math.min(70000, 4000 + altitude * 14);
    fogNear.value = Math.min(6000, 400 + altitude * 3);
    renderer.getDrawingBufferSize(size);
    fitShadowMap(size.x * size.y);
    follow(camera, gy, demo.shadowShift);
    forest.update(camera, size.y, fogFar.value);
    renderer.info.reset(); // (this frame's counts, the shadow map's included: the HUD's)
    renderer.render(scene, camera);
    frameTris = renderer.info.render.triangles;
  }

  installWebGLHarness(demo, { renderer, scene, camera, controls, frame, forest, instances, size, tris: () => frameTris });
  // the key help without the keys of what isn't here (anti-aliasing, wind, god rays, debug colours, freeze culling)
  for (const k of [...document.querySelectorAll('#help i')]) if (['T', 'G', 'R', 'L', 'F'].includes(k.textContent ?? '')) (k.nextElementSibling?.remove(), k.remove());
  // the performance panel and scene details, and the settings menu (src/menu.ts, its WebGL switches)
  const hud = createWebGLHud({ tris: () => frameTris, camera, controls, forest, auto, tau, size, adapterName, harness: harness && params.get('perf') !== '1', shadowsOn: () => shadowsOn });
  demo.perfReport = () => hud.perf?.report();
  demo.hud = hud;
  createMenu({ controls, u: { tau }, clouds: clouds.group, auto, perf: hud.perf, music, shadowsOn: () => shadowsOn, setShadows, setScale, touch: Boolean(touch) });
  await ui.update(0.9, 'Compiling shaders');
  // (in parallel where the browser has KHR_parallel_shader_compile; the first frame would compile one by one)
  terrainForAltitude(terrain, 0, true);
  await renderer.compileAsync(scene, camera).catch((e) => ui.note(`compileAsync: ${e}`));
  terrainForAltitude(terrain, 0);
  lap('Compiled');
  frame(0);
  ui.note('WebGL mode: first frame ready');
  await ui.reveal();
  // the forest floor after the first frame, its shader compiled meanwhile (~1.8 s of the dev machine's on its own):
  // till then the plain ground from high up (?glfloor=0: for good)
  const tg = performance.now();
  const proxy = new THREE.Mesh(nearGround.geometry, floorMat);
  proxy.receiveShadow = true;
  const floorIn = params.get('glfloor') === '0' ? Promise.resolve() : Promise.all([o.floorMaps.ready, renderer.compileAsync(proxy, camera, scene)]).then(() => {
    nearGround.material = floorMat;
    ui.note(`Forest floor in, ${Math.round(performance.now() - tg)} ms after the first frame`);
  });
  if (harness) await floorIn;
  else floorIn.catch((e) => console.error(e));
  let prev = performance.now();
  const loop = (): void => {
    const now = performance.now(), dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    frame(dt);
    steer(dt);
    hud.frame(now, dt);
  };
  if (!harness) renderer.setAnimationLoop(loop);
  demo.loopTest = (ms: number, on = true) => runLoop(renderer, auto, loop, ms, on);
  hud.update();
  demo.ready = true;
}
