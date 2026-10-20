// The reduced WebGL 2 mode (issue #39): where there's no WebGPU (Firefox on Android), after the loading screen's
// warning. three's WebGPURenderer on its WebGL 2 backend draws the same world, terrain, sky, clouds and forest floor,
// with the forest of src/webgl/forest.ts (no compute: no GPU culling, occlusion, software rasterizer or splats), the
// grass with its keep test in the vertex shader, no TAA, upscaling or god rays, and a resolution steered by the frame
// time. Built from the same loading work as main.ts (its workers, the trees' DAGs, the planting).
import * as THREE from 'three/webgpu';
import { Fn, attribute, float, mix, uniform } from 'three/tsl';
import { heightAt, terrainForAltitude, TERRAIN_SEGMENTS } from '../terrain.ts';
import { createGrass } from '../grass.ts';
import { setupGround } from '../ground/setup.ts';
import { VARIANTS, isModel, type BuiltTree } from '../trees.ts';
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
import { createWebGLStatues } from './statues.ts';
import { createWebGLOutput, floatTargets } from './output.ts';
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
import { typeMaskMode } from '../type-masks.ts';
import { debug, DEBUG_MODES } from './debug.ts';
import { runProfile, type ProfileProgress } from '../profile.ts';

/** The warning's second line (the loading screen's error panel, with a Continue button). */
export const WEBGL_HINT = 'Nanite Forest is built for WebGPU: Chrome or Edge on desktop and Android, Safari or desktop Firefox where they have it (not Firefox on Android yet). Without it, it can run in a reduced WebGL mode: simpler trees and lighter grass, and it may look different or be slow.';

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
  // the scene into a half-float target, then god rays, TAA and upscaling (src/webgl/output.ts); else straight to an
  // MSAA canvas. (GPU timers where the browser has EXT_disjoint_timer_query_webgl2: Chrome does, Firefox doesn't)
  const piped = floatTargets(params);
  const renderer = new THREE.WebGPURenderer({ forceWebGL: true, antialias: !piped, powerPreference: 'high-performance', trackTimestamp: params.get('gltimer') !== '0' });
  await renderer.init();
  const maxPr = Number(params.get('pr') ?? Math.min(window.devicePixelRatio, touch0 ? 1.25 : 1.5)); // (the resolution's 100%: auto.scale 1)
  renderer.setPixelRatio(touch0 ? Math.min(maxPr, 1) : maxPr);
  const scale0 = renderer.getPixelRatio() / maxPr; // (a phone starts lower)
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = params.get('shadows') !== '0';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(renderer.domElement);
  const gl = (renderer.backend as unknown as { gl?: WebGL2RenderingContext }).gl;
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const timed = Boolean(gl?.getExtension('EXT_disjoint_timer_query_webgl2')) && params.get('gltimer') !== '0';
  const adapterName = String((gl && (info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))) ?? 'unknown GPU');
  ui.note(`WebGL 2: ${adapterName}, ${gl?.getParameter(gl.VERSION) ?? '?'}, max texture ${gl?.getParameter(gl.MAX_TEXTURE_SIZE) ?? '?'}`);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.3, 150000);
  const { sky, sun, sunDir, fogNear, fogFar, skyCapture, cubeCam, makeFadeShadow, treeFarShadow, farShadowOn, follow, fitShadowMap, shadowFarOnly } = createLighting(scene, { harness });
  sky.renderOrder = 2;
  const clouds = createClouds();
  scene.add(clouds.group);
  clouds.group.visible = params.get('clouds') !== '0';
  // (the scene's pixel ratio at scale 1 is maxPr, as without the pipeline; the canvas at the display's)
  const resParams = new URLSearchParams(params);
  resParams.set('pr', String(maxPr));
  const out = piped ? createWebGLOutput(renderer, camera, sunDir, resParams) : null;

  await ui.update(0.04, 'Raising hills, sky and sun');
  const terrain = await o.terrainReady;
  scene.add(terrain);
  terrain.traverse((obj) => (obj.renderOrder = 1));
  const { cover, litter, groundFar, near: nearGround, floor: floorMat } = setupGround(terrain, o.floorMaps, forestRadius(o.trees), (far) => asReceivedShadow(makeFadeShadow(far)));

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
  // the wind's clock and switch (the trees' sway and the grass's)
  const windU = { time: uniform(0), prevTime: uniform(0), wind: uniform(params.get('wind') === '0' ? 0 : 1) };
  const impFade = makeFadeShadow(treeFarShadow);
  const forest = createWebGLForest(trees, instances, { bark: barkTex, leaf: leafTex, barkLayer, leafLayer }, atlas, {
    treeShadow: asReceivedShadow(makeFadeShadow(treeFarShadow)),
    impShadow: asReceivedShadow(Fn(([shadow]: [Float]) => impFade(shadow.mul(mix(float(1), treeFarShadow, farShadowOn))))),
    wind: windU,
    taa: Boolean(out?.taa.enabled),
    motion: Boolean(out?.wind),
    sunDir,
  });
  scene.add(forest.group);
  lap('Forest meshes');
  // the statues, once the model has arrived (Lucy: ~5 MB, maybe after the first frame)
  let statues: ReturnType<typeof createWebGLStatues> | null = null;
  const statuesIn = Promise.all(trees.map((t, v) => isModel(t.variant) && (t.later?.tree ?? Promise.resolve(t)).then((full) => {
    statues = createWebGLStatues(full, v, instances, forest.barkMat);
    forest.group.add(statues.group);
  })));
  // grass round the viewer (src/grass.ts: the keep test in the vertex shader, fewer blades than on WebGPU)
  const grass = createGrass({
    terrain: terrain.getObjectByName('terrain') as THREE.Mesh, size: o.terrainSize, segments: TERRAIN_SEGMENTS,
    cover, u: windU, receivedShadow: asReceivedShadow(makeFadeShadow(groundFar)), sunDir, renderer, webgl: true, motion: Boolean(out?.wind),
  });
  demo.grass = grass; // (in the scene after the first frame: below)
  const typeMasks = typeMaskMode({ renderer, hide: [terrain, grass.group], rays: out?.rays ?? { enabled: false }, fogNear, fogFar });
  lap('Grass');
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
  // presets; auto quality steers the resolution by the frame time, down to half over the budget, then the detail
  const budget = Number(params.get('budget') ?? (touch0 ? 33 : 17)); // ms a frame
  const auto: AutoQuality = { on: params.get('auto') !== '0' && !harness, budget, maxTau: 8, scale: scale0, gpuMs: 0, busy: false };
  const tau = { value: 1 };
  // what happened when, from the reveal (the report's startup timeline: what a flicker could be)
  let shownAt = 0;
  const events: string[] = [];
  const ev = (msg: string): void => void (events.length < 200 && events.push(`${((performance.now() - shownAt) / 1000).toFixed(2)} s  ${msg}`));
  const setScale = (s: number): void => {
    auto.trials?.push(`${(performance.now() / 1000).toFixed(2)} s: ${auto.scale.toFixed(2)} -> ${s.toFixed(2)} (median frame ${median.toFixed(1)} ms)`);
    ev(`resolution ${Math.round(auto.scale * 100)}% -> ${Math.round(s * 100)}% (median frame ${median.toFixed(1)} ms)`);
    auto.scale = s; // (applied by the next frame, just before it draws: see frame)
  };
  // By the median frame of each second, not an eased mean: one slow frame (a shader compile, the floor coming in, the
  // GPU catching up as the loop starts: 250-350 ms) pushed the mean over the budget, and the resolution stepped
  // down and back up twice in the first seconds, each a resize the user saw as a flicker. Nothing in the first 3 s
  // or 2 s after a step (a resize is a slow frame itself); up only if the larger size should stay under 85%.
  // A step down is a trial: if it didn't make frames 10% faster (the frame time was the CPU's or the display's, not
  // the pixels'), it goes back and the resolution holds for 30 s (as auto-quality.ts on WebGPU).
  let detail = tau.value, hold = 3, resHold = 0, detailHold = 0, median = 0, span = 0, times: number[] = [];
  let trial: { from: number; before: number } | null = null, detailTrial: { from: number; before: number } | null = null;
  const steer = (dt: number): void => {
    if (tau.value !== detail) forest.setDetail((detail = tau.value)); // (the menu, or the [ ] keys)
    resHold -= dt;
    detailHold -= dt;
    if ((hold -= dt) > 0) return void ((times = []), (span = 0)); // (the frames held off don't count)
    times.push(dt * 1000);
    if ((span += dt) < 1) return;
    median = [...times].sort((x, y) => x - y)[times.length >> 1];
    auto.frameMs = median;
    times = [];
    span = 0;
    if (!auto.on) return void (trial = detailTrial = null);
    const s = auto.scale;
    if (trial) {
      const failed = median > trial.before * 0.9;
      if (failed) auto.trials?.push(`step down saved ${Math.round((1 - median / trial.before) * 100)}%: back, held 30 s`);
      if (failed) ev(`that step saved ${Math.round((1 - median / trial.before) * 100)}%: back, held 30 s`);
      if (failed) (setScale(trial.from), (hold = 2), (resHold = 30));
      trial = null;
      if (failed) return;
    }
    if (detailTrial) { // (likewise: a coarser detail that saved under 5% goes back, held 30 s)
      const failed = median > detailTrial.before * 0.95;
      if (failed) ev(`that detail step saved ${Math.round((1 - median / detailTrial.before) * 100)}%: back, held 30 s`);
      if (failed) (stepDetail(detailTrial.from), (detailHold = 30));
      detailTrial = null;
      if (failed) return;
    }
    // at half the resolution (or with it held: its last step saved too little) and still over, the near trees'
    // detail (tau: their radii x 1 / sqrt(tau)), up to maxTau; coming back, the detail first (the reverse order)
    const over = median > budget * 1.15;
    if ((s <= 0.501 || resHold > 0) && over && tau.value < auto.maxTau && detailHold <= 0) {
      detailTrial = { from: tau.value, before: median };
      return void stepDetail(Math.min(auto.maxTau, tau.value * 1.5));
    }
    if (tau.value > 1 && median < budget * 0.6 && detailHold <= 0) return void stepDetail(Math.max(1, tau.value / 1.5));
    if (resHold > 0) return;
    const down = median > budget * 1.15 ? Math.max(0.5, s * 0.85) : s;
    const up = Math.min(1, s * 1.1), upCost = median * (up / s) ** 2; // (the cost goes with the pixels)
    const next = down < s ? down : median < budget * 0.7 && upCost < budget * 0.85 && tau.value <= 1 ? up : s;
    if (Math.abs(next - s) > 0.01) (next < s && (trial = { from: s, before: median }), setScale(next), (hold = 2));
  };
  const stepDetail = (t: number): void => {
    auto.trials?.push(`${(performance.now() / 1000).toFixed(2)} s: detail ${tau.value.toFixed(2)} -> ${t.toFixed(2)} (median frame ${median.toFixed(1)} ms)`);
    ev(`detail ${tau.value.toFixed(2)} -> ${t.toFixed(2)} (median frame ${median.toFixed(1)} ms)`);
    tau.value = t; // (steer applies it next frame: forest.setDetail)
    hold = 2;
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

  let time = 0, frameTris = 0, drawnWidth = 0;
  const waypoint = createWaypoint(harness && params.get('waypoint') !== '1'); // (to the plaza; as main.ts)
  const compass = createCompass(waypoint.target, harness && params.get('waypoint') !== '1');
  const size = out ? out.size : new THREE.Vector2(); // (the scene's pixels)
  let applied = 1;
  function frame(dt: number): void {
    // a new resolution right before this frame draws: resizing the canvas clears it, and set after a frame (auto
    // quality, the menu) the browser showed that frame blank, a flicker at every step (the user). With the output
    // pipeline it's the scene's target that's resized, the canvas stays at the display's.
    if (out && applied !== auto.scale) out.res.setScale((applied = auto.scale));
    if (!out && Math.abs(renderer.getPixelRatio() - maxPr * auto.scale) > 1e-6) renderer.setPixelRatio(maxPr * auto.scale);
    if (!out && renderer.domElement.clientWidth !== window.innerWidth || renderer.domElement.clientHeight !== window.innerHeight) {
      ev(`canvas resized ${renderer.domElement.clientWidth}x${renderer.domElement.clientHeight} -> ${window.innerWidth}x${window.innerHeight}`);
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
    time += dt;
    windU.prevTime.value = windU.time.value;
    windU.time.value = time;
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
    out?.begin(camera); // (the TAA's jitter: before anything is culled)
    waypoint.update(camera);
    compass.update(camera, controls.walking);
    const altitude = Math.max(0, camera.position.y - gy);
    music.setAltitude(altitude);
    terrainForAltitude(terrain, altitude);
    fogFar.value = Math.min(70000, 4000 + altitude * 14);
    fogNear.value = Math.min(6000, 400 + altitude * 3);
    typeMasks(debug.value === 4); // (debug 4: src/type-masks.ts)
    if (!out) renderer.getDrawingBufferSize(size);
    const smap = sun.shadow.mapSize.x;
    fitShadowMap(size.x * size.y);
    if (sun.shadow.mapSize.x !== smap) ev(`shadow map ${smap} -> ${sun.shadow.mapSize.x}`);
    follow(camera, gy, demo.shadowShift);
    // (from high up the average shadow everywhere, no shadow pass: lighting.ts FAR_TEXEL, as main.ts)
    const castShadows = shadowFarOnly() ? false : shadowsOn;
    sun.shadow.autoUpdate = castShadows;
    sun.shadow.camera.updateMatrixWorld();
    forest.update(camera, size.y, fogFar.value, castShadows ? sun.shadow.camera : null);
    grass.update(camera);
    statues?.update(camera, size.y);
    renderer.info.reset(); // (this frame's counts, the shadow map's included: the HUD's)
    if (out) out.draw(scene, camera);
    else renderer.render(scene, camera);
    frameTris = renderer.info.render.triangles;
    drawnWidth = renderer.domElement.width; // (the harness checks the canvas is still this size after the frame)
  }

  installWebGLHarness(demo, { timed, renderer, scene, camera, controls, frame, forest, instances, size, tris: () => frameTris, updateHud: () => hud.update(),
    heightOf: (i) => trees[instances.b[i * 4 + 2]].height * instances.a[i * 4 + 3], taa: out?.taa, rays: out?.rays });
  // the key help without the keys of what isn't here (freeze culling; anti-aliasing and god rays
  // without the float target)
  const absent = out ? ['F'] : ['T', 'R', 'F'];
  for (const k of [...document.querySelectorAll('#help i')]) if (absent.includes(k.textContent ?? '')) (k.nextElementSibling?.remove(), k.remove());
  // the performance panel and scene details, and the settings menu (src/menu.ts, its WebGL switches)
  const hud = createWebGLHud({ tris: () => frameTris, statues: () => statues?.count ?? 0, camera, controls, forest, auto, tau, size, output: out?.res.output ?? size, taa: () => Boolean(out?.taa.enabled), adapterName, harness: harness && params.get('perf') !== '1', shadowsOn: () => shadowsOn });
  demo.perfReport = () => hud.perf?.report();
  demo.hud = hud;
  // GPU profile (src/profile.ts: the steps there are here), from the menu; demo.profile() for the harness
  const profile = (progress?: ProfileProgress): Promise<string> => runProfile(
    {
      auto, trees: forest.group, taa: out?.taa, rays: out?.rays, clouds: clouds.group, grass: grass.group, terrain: [terrain, sky],
      shadowsOn: () => shadowsOn, setShadows, setScale, upscale: out ? { on: () => out.res.upscale, set: (v) => out.res.setUpscale(v) } : undefined,
    },
    (label, i, n, left) => (hud.perf?.status(`PROFILING ${i + 1}/${n}: ${label.toUpperCase()}`), progress?.(label, i, n, left)),
  );
  demo.profile = profile;
  createMenu({ controls, u: { tau, debug }, debugModes: DEBUG_MODES, profile: timed ? profile : undefined, taa: out?.taa, rays: out?.rays, clouds: clouds.group, grass: grass.group, wind: windU.wind, auto, perf: hud.perf, music, shadowsOn: () => shadowsOn, setShadows, setScale, touch: Boolean(touch) });
  await ui.update(0.9, 'Compiling shaders');
  // (in parallel where the browser has KHR_parallel_shader_compile; the first frame would compile one by one)
  terrainForAltitude(terrain, 0, true);
  out?.bind(); // (the programs depend on the target's outputs: compiled for the scene's, which it keeps between frames)
  // the forest floor and the grass after the first frame (their compiles ~1.8 and ~1.7 s on the dev machine), the
  // plain ground till then; ?glearly=1: compiled alongside and drawn in the first frame
  const late = params.get('glearly') !== '1';
  let tg = performance.now();
  const proxy = new THREE.Mesh(nearGround.geometry, floorMat);
  proxy.receiveShadow = true;
  const since = (): string => (late ? `${Math.round(performance.now() - tg)} ms after the first frame` : `${Math.round(performance.now() - tg)} ms into the compiles`);
  const floorLater = (): Promise<void> => (params.get('glfloor') === '0' ? Promise.resolve() : Promise.all([o.floorMaps.ready, renderer.compileAsync(proxy, camera, scene)]).then(() => {
    nearGround.material = floorMat;
    ui.note(`Forest floor in, ${since()}`);
    ev('forest floor in (the plain ground before)');
  }));
  // (?glgrass=0: no grass)
  const grassLater = (): Promise<void> => (params.get('glgrass') === '0' ? Promise.resolve() : renderer.compileAsync(grass.group, camera, scene).then(() => {
    scene.add(grass.group);
    ui.note(`Grass in, ${since()}`);
    ev('grass in');
  }));
  const early = late ? null : [floorLater(), grassLater()];
  await renderer.compileAsync(scene, camera).catch((e) => ui.note(`compileAsync: ${e}`));
  if (early) await Promise.all(early).catch((e) => ui.note(`Floor or grass: ${e}`));
  terrainForAltitude(terrain, 0);
  lap('Compiled');
  frame(0);
  ui.note('WebGL mode: first frame ready');
  await ui.reveal();
  shownAt = performance.now();
  ev(`shown: ${size.x}x${size.y}, resolution ${Math.round(auto.scale * 100)}%, shadow map ${sun.shadow.mapSize.x}`);
  if (hud.perf) hud.perf.extra = () => ['startup (s from the reveal: resolution steps, resizes, slow frames)', ...events.map((e) => `  ${e}`)].join('\n');
  if (late) tg = performance.now();
  const floorIn = early ? early[0] : floorLater(), grassIn = early ? early[1] : grassLater();
  // (?startloop=1 under the harness: the page's own first 10 s, the floor coming in meanwhile, as a person sees them)
  const startLoop = harness && params.get('startloop') === '1';
  if (harness && !startLoop) await Promise.all([floorIn, grassIn, statuesIn]);
  else Promise.all([floorIn, grassIn]).catch((e) => console.error(e));
  // the GPU time of the frames (eased, the panel's GPU line), one readback at a time
  const sampleGpu = (): void => {
    if (!timed || auto.busy) return;
    auto.busy = true;
    renderer.resolveTimestampsAsync('render').then((r) => {
      auto.busy = false;
      if (r === undefined || !(r > 0)) return;
      auto.gpuMs = auto.renderMs = auto.gpuMs ? auto.gpuMs * 0.9 + r * 0.1 : r;
      auto.onSample?.(r, 0); // (the GPU profile's raw samples)
    });
  };
  let prev = performance.now();
  const loop = (): void => {
    const now = performance.now(), dt = Math.min(0.1, (now - prev) / 1000);
    if (now - prev > 50 && now - shownAt < 60000) ev(`frame of ${Math.round(now - prev)} ms`);
    prev = now;
    frame(dt);
    steer(dt);
    sampleGpu();
    hud.frame(now, dt);
  };
  if (!harness) renderer.setAnimationLoop(loop);
  if (startLoop) {
    auto.on = params.get('auto') !== '0';
    renderer.setAnimationLoop(loop);
    await Promise.all([floorIn, grassIn, new Promise((r) => setTimeout(r, 10000))]);
    renderer.setAnimationLoop(null);
  }
  demo.loopTest = (ms: number, on = true) => runLoop(renderer, auto, loop, ms, on, () => drawnWidth);
  demo.withLoop = async <T>(run: () => Promise<T>): Promise<T> => {
    renderer.setAnimationLoop(loop);
    try {
      return await run();
    } finally {
      renderer.setAnimationLoop(null);
    }
  };
  hud.update();
  demo.ready = true;
}
