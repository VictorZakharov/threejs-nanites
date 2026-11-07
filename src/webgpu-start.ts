// The WebGPU mode (src/main.ts starts it once there's an adapter): the renderer and the scene's target, sky and
// terrain, the forest (src/webgpu-forest.ts), the controls, auto quality, the output passes, the frame
// (src/webgpu-frame.ts), the HUD, menu and harness API, then the shaders compiled and the first frame shown.
import * as THREE from 'three/webgpu';
import { vec4, mrt, output as colourOutput } from 'three/tsl';
import { heightAt, terrainForAltitude, type createTerrain } from './terrain.ts';
import { setupGround } from './ground/setup.ts';
import { VARIANTS, type BuiltTree } from './trees.ts';
import { PHASE2_LAYER } from './nanite-lib/index.ts';
import { LEAF_DITHER } from './nanite-lib/index.ts';
import { createClouds } from './clouds.ts';
import { FlyControls } from './controls.ts';
import { createAutoQuality } from './auto-quality.ts';
import { budgetFor, refreshRate } from './refresh.ts';
import { TouchControls, isTouchDevice } from './touch.ts';
import { forestRadius, type TreeInstances } from './placement.ts';
import { createLighting } from './lighting.ts';
import { runProfile, type ProfileProgress } from './profile.ts';
import { createMenu } from './menu.ts';
import { createZoomLog } from './zoom-log.ts';
import { installHarnessApi, type DemoState } from './harness-api.ts';
import { gpuBackend, asReceivedShadow } from './three-gaps.ts';
import { TAA } from './taa.ts';
import { createHud } from './hud.ts';
import { createWaypoint } from './waypoint.ts';
import { createCompass } from './compass.ts';
import { GodRays } from './godrays.ts';
import { typeMaskMode } from './type-masks.ts';
import { createMusic } from './music.ts';
import { createResolution } from './resolution.ts';
import { createSlowFrames } from './slow-frames.ts';
import { createPrepassTrial } from './prepass-trial.ts';
import { createTierSwitches } from './low-tiers.ts';
import { Precompile, warmUp } from './warmup.ts';
import { buildForest } from './webgpu-forest.ts';
import { createFrame } from './webgpu-frame.ts';
import type { AutoQuality } from './hud.ts';
import type { LoadingScreen } from './loading.ts';
import type { FloorMaps } from './ground/floor.ts';
import type { LayerData } from './texture-pixels.ts';
import type { SceneName } from './scene.ts';

export interface WebGPUStart {
  adapter: GPUAdapter;
  ui: LoadingScreen;
  demo: DemoState;
  params: URLSearchParams;
  harness: boolean;
  trees: number;
  terrainSize: number;
  barkTypes: string[];
  leafTypes: string[];
  t0: number;
  plantedMs: () => number;
  barkLayers: Promise<LayerData>[];
  leafLayers: Promise<LayerData>[];
  floorMaps: FloorMaps;
  planting: Promise<TreeInstances>;
  growing: Promise<BuiltTree[]>;
  terrainReady: ReturnType<typeof createTerrain>;
  scene: Promise<SceneName>; // (src/scene.ts: the planting waits for it)
}

export async function startWebGPU(o: WebGPUStart): Promise<void> {
  const { adapter, ui, demo, params, harness: HARNESS, trees: TREE_COUNT, terrainSize, barkTypes, leafTypes, t0, plantedMs } = o;
  const { barkLayers, leafLayers, floorMaps, planting, growing, terrainReady, scene: sceneName } = o;
  const lim = adapter.limits;
  if (lim.maxStorageBuffersPerShaderStage < 10) throw new Error('GPU supports too few storage buffers per stage.');
  const renderer = new THREE.WebGPURenderer({
    antialias: false, // (the scene renders into its own MSAA target, see sceneRT)
    reversedDepthBuffer: params.get('rdb') === '1', // (breaks the terrain/fog here; off)
    powerPreference: 'high-performance',
    trackTimestamp: true, // GPU time drives the auto quality (and the harness numbers)
    requiredLimits: {
      // (?maxsb=N: pretend the GPU allows only N, to reproduce smaller GPUs' limits)
      maxStorageBuffersPerShaderStage: Math.min(lim.maxStorageBuffersPerShaderStage, Number(params.get('maxsb') ?? Infinity)),
      maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
      maxBufferSize: lim.maxBufferSize,
    },
  });
  await renderer.init();
  if (!gpuBackend(renderer).isWebGPUBackend) throw new Error('WebGPU backend unavailable (got WebGL fallback).');
  const ai = adapter.info ?? {};
  ui.note(`WebGPU adapter: ${[ai.vendor, ai.architecture, ai.description].filter(Boolean).join(' ') || 'unknown'}`);
  renderer.setSize(window.innerWidth, window.innerHeight); // (the pixel ratios: src/resolution.ts)
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  // Shadows stay compiled in; turning them "off" zeroes the intensity and skips the shadow pass. Toggling
  // renderer.shadowMap.enabled instead recompiles every shader (a ~10 s freeze).
  renderer.shadowMap.enabled = true;
  let shadowsOn = params.get('shadows') !== '0';
  renderer.shadowMap.type = params.get('shadowfilter') === 'basic' ? THREE.BasicShadowMap : THREE.PCFShadowMap; // (?shadowfilter=basic: one tap)
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.3, 150000);
  // The scene renders into its own MSAA target (the occlusion culling reads its depth between the two tree phases),
  // then a fullscreen pass tone-maps it to the canvas.
  // (two outputs: colour, and the wind's screen motion of the trees for the anti-aliasing, see src/taa.js)
  // MSAA of the scene target (WebGPU has 1 or 4 samples): none under TAA, where the leaves are dithered by coverage
  // (LEAF_DITHER) and TAA averages them; 4x MSAA with its alpha to coverage cost ~2.5 ms on High at 1080p on the
  // user's 4070 Ti. 4 with ?taa=0 or ?leafalpha=a2c, or ?msaa=4.
  const samples = Number(params.get('msaa') ?? (params.get('aa') === '0' || LEAF_DITHER ? 1 : 4)) > 1 ? 4 : 1;
  const sceneRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true, count: 2 });
  sceneRT.textures[0].name = 'output';
  sceneRT.textures[1].name = 'wind';
  const sceneMRT = mrt({ output: colourOutput, wind: vec4(0) }); // (still everywhere but the trees)
  sceneMRT.setClearColor('wind', 0x000000, 0);
  sceneRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  // shaders compile ahead, in parallel, each as soon as its material is final (src/warmup.ts); against a 1x1 copy of
  // the target (the same formats: the same pipelines), as the scene's own is resized while they compile
  const compileRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true, count: 2 });
  compileRT.textures[0].name = 'output';
  compileRT.textures[1].name = 'wind';
  compileRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  const pre = new Precompile(renderer, scene, camera, compileRT, sceneMRT, params.get('precompile') !== '0');

  const lighting = createLighting(scene, { harness: HARNESS });
  const { sky, sun, sunDir, fogNear, fogFar, follow, farShadowOn, makeFadeShadow } = lighting;

  await ui.update(0.04, 'Raising hills, sky and sun');
  // drawn after the trees, the sky last: what the trees hide is then rejected by its depth before the floor's
  // shader (relief, litter) runs (created first, they were drawn first: over the canopy -0.5 ms, -0.2 elsewhere)
  sky.renderOrder = 2;
  const clouds = createClouds();
  scene.add(clouds.group);
  clouds.group.traverse((o) => o.layers.set(PHASE2_LAYER)); // (transparent: drawn after both tree phases)
  clouds.group.visible = params.get('clouds') !== '0'; // (debug switch)
  pre.add(sky, clouds.group); // (the GPU is idle while the trees grow)
  const terrain = await terrainReady;
  scene.add(terrain);
  terrain.traverse((o) => (o.renderOrder = 1));
  // the ground's shaders compile from here, the slowest (src/ground/setup.ts)
  const ground = setupGround(terrain, floorMaps, forestRadius(TREE_COUNT), (far) => asReceivedShadow(makeFadeShadow(far)));
  const { cover: density, litter, near: nearGround, floor: floorMat } = ground;
  demo.coverMap = density; // (harness: --probe=autumn reads the fallen leaves, and each variant's kind of leaf)
  demo.leafOf = VARIANTS.map((v) => v.leaf);
  demo.litter = litter;
  terrainForAltitude(terrain, 0, true); // (both the detailed and the high ground; the first frame picks one)
  pre.add(terrain);


  const built = await buildForest({
    harness: HARNESS,
    renderer, scene, camera, ui, demo, params, TREE_COUNT, terrainSize, barkTypes, leafTypes, t0, plantedMs, barkLayers, leafLayers, planting, growing,
    sceneName, samples, terrain, ground, lighting, shadowsOn: () => shadowsOn, pre,
  });
  const { forest, grass, instances, buildMs, covered } = built;
  let { passes } = built;

  // camera + controls
  const controls = new FlyControls(camera, renderer.domElement);
  demo.controls = controls;
  camera.position.set(20, heightAt(20, 40) + 1.8, 40);
  controls.yaw = THREE.MathUtils.degToRad(30);
  controls.pitch = THREE.MathUtils.degToRad(4);
  const touch = (HARNESS ? params.get('touch') === '1' : isTouchDevice(params)) ? new TouchControls(controls, renderer.domElement) : null; // (src/touch.js)
  controls.touchMode = Boolean(touch);
  // walking on the ground (double jump flies, landing walks); the harness places its views in the air: flying only
  controls.groundAt = heightAt;
  controls.walkEnabled = !HARNESS || params.get('walk') === '1';
  controls.walking = controls.walkEnabled;

  function setShadows(on: boolean): void {
    shadowsOn = on;
    sun.shadow.intensity = on ? 1 : 0;
    farShadowOn.value = on ? 1 : 0;
    sun.shadow.autoUpdate = on;
    sun.shadow.needsUpdate = true; // one last pass (empty when off: the casters are hidden)
    forest.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.castShadow) o.visible = on;
    });
  }
  setShadows(shadowsOn);

  // Auto quality (src/auto-quality.ts): steers tau so the GPU time stays within the budget
  // (a desktop's 5.5 ms leaves ~1.2 ms of the rest of the frame inside a 144 Hz frame: at 8 the user's 4070 Ti sat at
  // ~115 fps; a phone's budget is a 60 fps frame: its GPU is far from a desktop one)
  const fixedBudget = params.get('budget') ?? (isTouchDevice(params) ? '14' : null);
  const budget = fixedBudget ? Number(fixedBudget) : budgetFor(refreshRate());
  // (?automin=) In the Lucy forest there's no point in spending the budget on detail past tau 3: 15M triangles on a 2M pixel
  // screen at tau 2.3 (the user), and far statues look the same at 2.3 and 4; `userstill` 8.7M -> 5.1M, `statue`'s pops
  // +12% (--sweep=lod, 715 -> 799), its feathers softer from 4 on. A preset or a manual tau can still go finer.
  const auto: AutoQuality = { on: params.get('auto') === '1' || (params.get('auto') !== '0' && !HARNESS), budget, maxTau: 8, scale: 1, gpuMs: 0, busy: false };
  // (where it settled on this screen and scene: the next visit starts there; ?autoremember=0 never, the harness only with =1)
  if (params.get('autoremember') === '1' || (!HARNESS && params.get('autoremember') !== '0')) {
    void sceneName.then((name) => (auto.remember = `nanite-auto ${name} ${screen.width}x${screen.height}@${devicePixelRatio} ${budget}`));
  }
  void sceneName.then((name) => (auto.minTau = Number(params.get('automin') ?? (name === 'lucy' ? 3 : 1))));
  // (phones start lower: each step down reallocates the targets and restarts TAA, a hitch the first seconds were full of)
  const startScale = auto.on && isTouchDevice(params) ? 0.6 : 1;
  const setScale = (s: number): void => {
    auto.scale = s;
    res.setScale(s);
  };
  // (?autozoom=0: one setting for the zoomed and unzoomed view, as before)
  const autoQuality = createAutoQuality(renderer, auto, forest.u.tau, setScale, () => res.maxScale(), params.get('autozoom') === '0' ? null : controls, createTierSwitches({ params, forest, grass, res: () => res, lighting, rays: () => rays }));
  controls.onZoom = autoQuality.followZoom;
  // (the leaves' prepass timed both ways on this GPU: src/prepass-trial.ts)
  const prepassTrial = createPrepassTrial(auto, forest.leafPrepass, () => controls.zoomTarget > 1, autoQuality.log, () => `${forest.u.tau.value} ${auto.scale} ${auto.tier ?? 0}`);

  // Follow the window size. Checked every frame rather than only on 'resize': a resize that happens while loading
  // (e.g. F11 / fullscreen during the shader compile) fires before any listener exists and left a gap at the bottom.
  // light shafts through the canopy (src/godrays.js; R or ?rays=0), added to the scene before the TAA resolve
  const rays = new GodRays(renderer, sceneRT.depthTexture, sunDir, { enabled: params.get('rays') !== '0' });
  // temporal anti-aliasing (src/taa.js): the output shows its resolved history
  const taa = new TAA(renderer, sceneRT, samples, { enabled: params.get('taa') !== '0', extra: rays.at });
  const typeMasks = typeMaskMode({ renderer, hide: [terrain, grass.group], rays, fogNear, fogFar });
  // (alpha 1: alpha-to-coverage leaves leave alpha < 1 in the target, and the canvas would show the page through)
  const output = new THREE.RenderPipeline(renderer, vec4(taa.displayNode, 1));
  if (params.has('tier')) autoQuality.hold(Number(params.get('tier'))); // (a test: src/auto-quality.ts)
  forest.setDepthSource(sceneRT.depthTexture, samples);
  forest.occlusionOn = params.get('occ') !== '0';

  // the canvas at the display's resolution, the scene at auto quality's (src/resolution.ts; the TAA upscales)
  const res = createResolution(renderer, camera, sceneRT, params);
  taa.size = res.taa; // (the history at the TAA's size, the output pass upscales it to the canvas)
  if (params.get('taapr')) res.capOutput(Number(params.get('taapr'))); // (the TAA's pixel ratio, as tier 2 sets it: the harness's A/B)
  if (params.get('shadowtauscale')) forest.shadowTauScale = Number(params.get('shadowtauscale')); // (a tier's: the harness's A/B)
  const size = res.render; // (the scene's pixels: what everything but the TAA resolve and the output works in)
  const fitToWindow = (): void => res.fit();
  fitToWindow();
  window.addEventListener('resize', fitToWindow);
  if (startScale < 1) setScale(startScale);

  // ---------------------------------------------------------------- frame
  const music = createMusic(params, HARNESS); // (ez-tree's birdsong, from the first click, tap or key)
  demo.music = music;
  const waypoint = createWaypoint(HARNESS && params.get('waypoint') !== '1');
  const compass = createCompass(waypoint.target, HARNESS && params.get('waypoint') !== '1');
  const frame = createFrame({
    renderer, scene, camera, controls, touch, demo, TREE_COUNT, terrain, forest, clouds, grass, litter, lighting, waypoint, compass, music, res, size,
    sceneRT, sceneMRT, taa, rays, output, typeMasks, fitToWindow, shadowsOn: () => shadowsOn,
  });

  // HUD and performance panel
  const hud = createHud({
    renderer, camera, controls, forest, taa, auto, size, output: res.output, taaSize: res.taa, samples, shadowsOn: () => shadowsOn,
    harness: HARNESS && params.get('perf') !== '1', // (?perf=1: the panel under the harness too)
    adapterName: [ai.vendor, ai.architecture, ai.description].filter(Boolean).join(' ') || 'unknown adapter',
  });
  const updateHud = hud.update;
  demo.perfReport = () => hud.perf?.report();
  const zoomLog = createZoomLog({
    tau: forest.u.tau, scale: () => auto.scale, zoom: controls, forest,
    shadow: () => ({ size: sun.shadow.mapSize.x, half: (sun.shadow.camera as THREE.OrthographicCamera).right }),
  });
  // (the report's slow frames by cause: src/slow-frames.ts)
  const slowFrames = createSlowFrames();
  if (hud.perf) hud.perf.extra = () => [slowFrames.report(), zoomLog.report()].filter(Boolean).join('\n\n');
  demo.hud = hud;
  // GPU profile (src/profile.ts): the panel's PROFILE button, demo.profile() for the harness
  const profile = (progress?: ProfileProgress): Promise<string> => runProfile(
    {
      auto, forest, taa, rays, clouds: clouds.group, grass: grass.group, terrain: [terrain, sky], shadowsOn: () => shadowsOn, setShadows, setScale,
      upscale: { on: () => res.upscale, set: (v) => res.setUpscale(v) },
    },
    (label, i, n, left) => (hud.perf?.status(`PROFILING ${i + 1}/${n}: ${label.toUpperCase()}`), progress?.(label, i, n, left)),
  );
  demo.profile = profile;
  // settings menu + keyboard shortcuts (src/menu.ts)
  createMenu({ controls, u: forest.u, forest, taa, rays, clouds: clouds.group, grass: grass.group, auto, perf: hud.perf, music, shadowsOn: () => shadowsOn, setShadows, setScale, profile, touch: Boolean(touch) });

  // At most a few frames on the GPU (?gpuqueue=N, below): Chrome queued
  // several 40 ms frames on the AMD PC's iGPU, which it shares with Windows' compositor, and the whole PC lagged behind them
  // (the user: the mouse moved in jumps, a button click was skipped).
  // (?gpuqueue=N: at most N frames on the GPU, 0 no limit; default 2: one drawn, one waiting, so the GPU never idles to the
  // next vsync. The AMD PC at 1080p: no limit, frames waited a median 5 s in the queue; 1, 45 ms but 14% fewer frames)
  const maxQueue = Number(params.get('gpuqueue') ?? 2);
  let inFlight = 0;
  const gpuBound = (): boolean => maxQueue > 0; // (always: a GPU that keeps up never has 2 waiting)
  let prev = performance.now();
  // (?simskip=N: skips N of every N+1 display frames, as a GPU behind the display whose timers read low: the harness's test of
  // auto quality's frame-rate signal, src/auto-quality.ts behindMs)
  const SIM_SKIP = Number(params.get('simskip') ?? 0);
  let rafs = 0;
  function loop() {
    if (SIM_SKIP && rafs++ % (SIM_SKIP + 1) !== 0) return;
    const now = performance.now();
    const skip = inFlight >= maxQueue && maxQueue > 0;
    slowFrames.begin(now, skip, auto.queueMs ?? 0);
    if (skip) return; // (the GPU has its frames: this display frame is skipped)
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    if (pre.pending) pre.apart(() => frame(dt)); // (a compile in flight reads the renderer's target: Precompile.after)
    else frame(dt);
    // (from the frame's submit to its GPU work done: past a frame's own GPU time, frames are waiting in the queue, and so is
    // the desktop's compositor behind them. The report's 'gpu queue'; --probe=gpuqueue on the AMD PC)
    const submitted = performance.now(), bound = gpuBound();
    if (bound) inFlight++;
    gpuBackend(renderer).device.queue.onSubmittedWorkDone().then(() => {
      const ms = performance.now() - submitted;
      auto.queueMs = auto.queueMs ? auto.queueMs * 0.9 + ms * 0.1 : ms;
      (auto.queueLog ??= []).push(ms);
      if (auto.queueLog.length > 3000) auto.queueLog.shift();
    }).finally(() => {
      if (bound) inFlight--;
    });
    if (!fixedBudget && !auto.tuning) auto.budget = budgetFor(refreshRate());
    autoQuality.step(dt);
    prepassTrial.step(now);
    zoomLog.frame(now, dt);
    hud.frame(now, dt);
    const end = performance.now();
    slowFrames.end(end);
    auto.mainMs = auto.mainMs ? auto.mainMs * 0.9 + (end - now) * 0.1 : end - now;
  }

  // ---------------------------------------------------------------- harness API
  installHarnessApi(demo, {
    renderer, sceneRT, scene, camera, forest, controls, adapter, instances, buildMs, size, auto, frame, loop, setShadows, setScale, updateHud, taa,
    shadowsOn: () => shadowsOn,
    setBenchMs: (m) => hud.setBenchMs(m),
  });

  // Compile everything before revealing (src/warmup.ts): the compiles started ahead, the compute passes, then each
  // group drawn and each GPU stage run once (what wasn't compiled ahead compiles there).
  const tc = performance.now();
  fitToWindow();
  follow(camera, heightAt(camera.position.x, camera.position.z), demo.shadowShift);
  const stages: [string, () => void][] = [
    ['culling', () => forest.update(camera, size, 0, shadowsOn ? sun.shadow.camera : null)],
    ['occlusion', () => forest.occlusion(camera, size.x, size.y)],
    ['software rasterizer', () => forest.rasterize(camera, size.x, size.y)],
    ['the first frame', () => frame(0)],
  ];
  passes += pre.addComputes(() => {
    stages.slice(0, 3).forEach(([, run]) => run());
    grass.update(camera);
  });
  await covered;
  await ui.update(0.84, 'Compiling shaders', false);
  const slowest = await pre.done();
  if (pre.on) ui.note(`Compiled the materials and ${passes} compute passes in parallel (slowest: ${slowest}), waited (${Math.round(performance.now() - tc)} ms)`);
  const byName = (prefix: string): THREE.Object3D[] => forest.group.children.filter((o) => o.name.startsWith(prefix));
  // (compiled ahead, one draw of everything compiles the shadow-map versions and one frame the full-screen passes;
  // else a group and a stage at a time, so the bar moves between the compiles)
  const all = [terrain, sky, clouds.group, ...forest.group.children];
  await warmUp(ui, {
    renderer, scene, camera, target: sceneRT, mrt: sceneMRT, sun, shadowsOn, all,
    stages: pre.on ? stages.slice(-1) : stages,
    groups: pre.on ? [['shadows', all]] : [
      ['terrain and sky', [terrain, sky]],
      ['bark', byName('nanite-bark')],
      ['leaves', byName('nanite-leaves')],
      ['impostors', byName('nanite-impostors')],
      ['software rasterizer resolve', [...byName('nanite-software-resolve'), ...byName('nanite-splat-resolve')]],
      ['clouds', [clouds.group]],
    ],
  });
  ui.note(`First frame ready (${Math.round(performance.now() - tc)} ms)`);
  await ui.reveal();
  if (!HARNESS) renderer.setAnimationLoop(loop);
  // the forest floor's shader, the slowest to compile, after the first frame (src/ground/setup.ts): till then the near
  // square has the ground from high up (no litter, relief or cobbles); then once its maps are in too
  const tg = performance.now();
  const proxy = new THREE.Mesh(nearGround.geometry, floorMat); // (the same pipeline as the square's)
  proxy.receiveShadow = nearGround.receiveShadow;
  const floorIn = Promise.all([floorMaps.ready, pre.after(proxy)]).then(([floor]) => {
    nearGround.material = floorMat;
    ui.note(`Forest floor in, ${Math.round(performance.now() - tg)} ms after the first frame (its maps in workers: ${floor.ms.join(' / ')} ms, done ${floor.doneMs} ms in)`);
  });
  if (HARNESS) await floorIn; // (views and screenshots with the floor)
  else floorIn.catch((e) => console.error(e));
  demo.ready = true;
}
