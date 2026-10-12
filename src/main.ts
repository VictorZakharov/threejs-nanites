import * as THREE from 'three/webgpu';
import { Fn, attribute, float, mix, positionWorld, smoothstep, texture, uniform, vec4, mrt, output as colourOutput } from 'three/tsl';
import { createTerrain, heightAt, TERRAIN_SEGMENTS, meadowColour } from './terrain.ts';
import { createGrass } from './grass.ts';
import { loadFloorMaps, applyFloor } from './ground/floor.ts';
import { createLitterMap } from './ground/litter-map.ts';
import { buildAllTrees, VARIANTS } from './trees.ts';
import { NaniteForest } from './nanite/forest.ts';
import { PHASE2_LAYER } from './nanite/constants.ts';
import { makeLeafAlpha, LEAF_DITHER, mipBias } from './nanite/shading.ts';
import { bakeImpostors, impostorCoverage, IMPOSTOR_CUT } from './impostors.ts';
import { viewerPos } from './planet.ts';
import { createClouds, CLOUD_BASE } from './clouds.ts';
import { FlyControls } from './controls.ts';
import { createAutoQuality } from './auto-quality.ts';
import { TouchControls, isTouchDevice } from './touch.ts';
import { LoadingScreen } from './loading.ts';
import { arrayTexture, layerLookup } from './textures.ts';
import { stoneTextureUrl } from './stone.ts';
import { MAX_ALTITUDE, forestRadius, forestDensity, plantForest } from './placement.ts';
import { createLighting } from './lighting.ts';
import { runProfile } from './profile.ts';
import { createMenu } from './menu.ts';
import { installHarnessApi, type DemoState } from './harness-api.ts';
import { gpuBackend, asReceivedShadow } from './three-gaps.ts';
import type { AutoQuality } from './hud.ts';
import type { ImpostorAtlas } from './impostors.ts';
import type { Float, Vec3 } from './types.ts';

declare global {
  interface Window {
    __demo: DemoState; // (what the harness drives, see harness-api.ts)
  }
}
import { TAA } from './taa.ts';
import { createHud } from './hud.ts';
import { createWaypoint } from './waypoint.ts';
import { createCompass } from './compass.ts';
import { GodRays } from './godrays.ts';
import { createMusic } from './music.ts';
import { createResolution } from './resolution.ts';

const params = new URLSearchParams(location.search);
const HARNESS = params.has('harness');
const SW_ALTITUDE = Number(params.get('swalt') ?? 25); // m above the ground (?swalt=0: the software rasterizer everywhere)
// occlusion culling below this (m above the ground; ?occalt=): 260 m up it cost 0.24 ms, 8.8 km up 0.4, a phone 9%
const OCC_ALTITUDE = Number(params.get('occalt') ?? 150);
const TREE_COUNT = Number(params.get('trees') ?? 1000000);
if (HARNESS) document.body.classList.add('harness');
if (params.get('help') === '1') document.body.classList.add('show-help'); // (the key help under the harness)

// shadowShift: debug offset of the shadow-map centre (harness sweeps)
const demo: DemoState = (window.__demo = { ready: false, error: null, shadowShift: new THREE.Vector3() });
const ui = new LoadingScreen();

// ---------------------------------------------------------------- setup
async function start() {
  await ui.update(0.02, 'Waking the GPU');
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser (try Chrome or Edge).');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter.');
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

  const { sky, sun, sunDir, fogNear, fogFar, fogColour, skyCapture, cubeCam, makeFadeShadow, treeFarShadow, farShadowOn, follow, fitShadowMap, shadowFarOnly } =
    createLighting(scene, { harness: HARNESS });

  await ui.update(0.04, 'Raising hills, sky and sun');
  // terrain reaches past the ragged forest edge (trees go out to 1.35 x radius) and the fog
  const terrainSize = Math.max(9000, Math.ceil(forestRadius(TREE_COUNT) * 2.7 + 3000));
  const terrain = createTerrain(terrainSize);
  const floorMaps = loadFloorMaps(); // (a worker: the forest floor's maps, src/ground/)
  scene.add(terrain);
  // drawn after the trees, the sky last: what the trees hide is then rejected by its depth before the floor's
  // shader (relief, litter) runs (created first, they were drawn first: over the canopy -0.5 ms, -0.2 elsewhere)
  terrain.traverse((o) => (o.renderOrder = 1));
  sky.renderOrder = 2;
  const clouds = createClouds();
  scene.add(clouds.group);
  clouds.group.traverse((o) => o.layers.set(PHASE2_LAYER)); // (transparent: drawn after both tree phases)
  clouds.group.visible = params.get('clouds') !== '0'; // (debug switch)

  // trees
  const t0 = performance.now();
  // the forest is planted in workers while the trees grow (src/planting.ts)
  let plantedMs = 0;
  const planting = plantForest(TREE_COUNT).then((p) => ((plantedMs = performance.now() - t0), p));
  const trees = await buildAllTrees(ui);
  const buildMs = performance.now() - t0;
  await ui.update(0.77, 'Pressing leaves and bark into texture arrays');

  const barkTypes = ['oak', 'birch', 'pine', 'stone']; // (stone: the models')
  const leafTypes = ['oak', 'ash', 'aspen', 'pine'];
  const [barkTex, leafTex] = await Promise.all([
    arrayTexture(barkTypes.map((t) => (t === 'stone' ? stoneTextureUrl() : `./textures/${t}_color_1k.jpg`)), 1024),
    arrayTexture(leafTypes.map((t) => `./textures/${t}_color.png`), 1024, true),
  ]);
  barkTex.colorSpace = leafTex.colorSpace = THREE.SRGBColorSpace;
  leafTex.wrapS = leafTex.wrapT = THREE.ClampToEdgeWrapping;

  await ui.update(0.8, `Scattering ${TREE_COUNT.toLocaleString()} trees`);
  let ts = performance.now();
  const lap = (label: string): void => {
    ui.note(`${label} (${Math.round(performance.now() - ts)} ms)`);
    ts = performance.now();
  };
  const instances = await planting;
  lap(`Planted ${(instances.a.length / 4).toLocaleString()} trees, bushes and statues in workers, done ${Math.round(plantedMs)} ms in; waited`);
  // MSAA of the scene target (WebGPU has 1 or 4 samples): none under TAA, where the leaves are dithered by coverage
  // (LEAF_DITHER) and TAA averages them; 4x MSAA with its alpha to coverage cost ~2.5 ms on High at 1080p on the
  // user's 4070 Ti. 4 with ?taa=0 or ?leafalpha=a2c, or ?msaa=4.
  const samples = Number(params.get('msaa') ?? (params.get('aa') === '0' || LEAF_DITHER ? 1 : 4)) > 1 ? 4 : 1;
  const forest = new NaniteForest(renderer, trees, instances, {
    bark: barkTex,
    leaf: leafTex,
    barkLayerOf: layerLookup(VARIANTS.map((v) => barkTypes.indexOf(v.bark))),
    leafLayerOf: layerLookup(VARIANTS.map((v) => leafTypes.indexOf(v.leaf))),
    alphaToCoverage: samples > 1 && params.get('a2c') !== '0',
    leafDither: samples === 1 && LEAF_DITHER,
  });
  lap('Forest buffers and passes');
  forest.u.tau.value = Number(params.get('tau') ?? 1);
  forest.u.maxDist.value = fogFar.value; // beyond the fog a tree is invisible: don't even cull its clusters
  forest.u.debug.value = Number(params.get('debug') ?? 0);
  if (params.get('wind') === '0') forest.u.wind.value = 0;
  forest.group.traverse((o) => {
    if (o instanceof THREE.Mesh && !o.castShadow) (o.material as THREE.NodeMaterial).receivedShadowNode = asReceivedShadow(makeFadeShadow(treeFarShadow));
  });
  // software-rasterized tiny clusters: shaded per pixel from the visibility buffer, with the same shadows and fog
  forest.group.add(forest.sw.buildResolveMesh({
    fadeShadow: (pos: Vec3) => makeFadeShadow(treeFarShadow, pos),
    fog: (pos: Vec3, viewZ: Float) => ({ color: fogColour(pos), factor: smoothstep(fogNear, fogFar, viewZ) }),
  }));
  // ground: darkened by how much canopy stands over it
  lap('Software rasterizer');
  const density = forestDensity(instances);
  lap('Canopy cover map');
  demo.coverMap = density; // (harness: --probe=autumn reads the fallen leaves, and each variant's kind of leaf)
  demo.leafOf = VARIANTS.map((v) => v.leaf);
  const groundShade = uniform(Number(params.get('groundshade') ?? 0.7));
  const coverMap = texture(density.texture, positionWorld.xz.div(density.extent * 2).add(0.5));
  const cover = coverMap.r;
  const groundFar = float(1).sub(cover.mul(groundShade));
  for (const m of terrain.userData.materials as THREE.NodeMaterial[]) m.receivedShadowNode = asReceivedShadow(makeFadeShadow(groundFar));
  // the forest floor near the viewer: leaf litter under the canopy, parallax relief (src/ground/)
  const nearGround = terrain.getObjectByName('terrain') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  const litter = createLitterMap(instances); // (which tree's leaves lie where near the viewer)
  demo.litter = litter;
  lap('Litter map');
  applyFloor(nearGround.material, await floorMaps, meadowColour(), coverMap, litter);
  lap('Forest floor');
  // grass around the viewer (src/grass.ts)
  const grass = createGrass({
    terrain: terrain.getObjectByName('terrain') as THREE.Mesh, size: terrainSize, segments: TERRAIN_SEGMENTS,
    cover: density, u: forest.u, receivedShadow: asReceivedShadow(makeFadeShadow(groundFar)),
  });
  scene.add(grass.group);
  scene.add(forest.group);
  lap('Grass');

  await ui.update(0.82, 'Baking far-field impostors and the sky');
  cubeCam.update(renderer, skyCapture);
  const baked = bakeImpostors(renderer, trees, {
    bark: barkTex,
    leaf: leafTex,
    barkLayers: VARIANTS.map((v) => barkTypes.indexOf(v.bark)),
    leafLayers: VARIANTS.map((v) => leafTypes.indexOf(v.leaf)),
    leafAlpha: makeLeafAlpha(leafTex, attribute('uv', 'vec2')),
  }, Number(params.get('bakepx') ?? forest.u.impostorPx.value)); // (the default switch size, before ?imppx=)
  const atlas: ImpostorAtlas = { ...baked, coverage: await impostorCoverage(renderer, baked, IMPOSTOR_CUT) };
  const impostorMesh = forest.buildImpostorMesh(atlas, VARIANTS.map((v) => v.impGain));
  impostorMesh.receiveShadow = true;
  // an impostor looks the map up on its sun side (the neighbours' shadows), its own crown's shade is the average
  const impFade = makeFadeShadow(treeFarShadow);
  (impostorMesh.material as THREE.NodeMaterial).receivedShadowNode = asReceivedShadow(Fn(([shadow]: [Float]) => impFade(shadow.mul(mix(float(1), treeFarShadow, farShadowOn)))));
  demo.atlas = atlas; // (for probes: the atlas can be read back and dumped)
  demo.renderer = renderer;
  impostorMesh.visible = params.get('imp') !== '0'; // (debug switch)
  if (params.has('imppx')) forest.u.impostorPx.value = Number(params.get('imppx'));
  forest.group.add(impostorMesh);
  const impostorShadow = forest.buildImpostorShadowMesh(atlas);
  impostorShadow.visible = impostorMesh.visible;
  forest.group.add(impostorShadow);
  ui.note(`Impostor atlas: ${atlas.frames.length} tiles; trees under ${forest.u.impostorPx.value}px tall become 2-triangle quads`);

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
  const budget = Number(params.get('budget') ?? (isTouchDevice(params) ? 14 : 5.5));
  const auto: AutoQuality = { on: params.get('auto') === '1' || (params.get('auto') !== '0' && !HARNESS), budget, maxTau: 8, scale: 1, gpuMs: 0, busy: false };
  // (phones start lower: each step down reallocates the targets and restarts TAA, a hitch the first seconds were full of)
  const startScale = auto.on && isTouchDevice(params) ? 0.6 : 1;
  const setScale = (s: number): void => {
    auto.scale = s;
    res.setScale(s);
  };
  // (?autozoom=0: one setting for the zoomed and unzoomed view, as before)
  const autoQuality = createAutoQuality(renderer, auto, forest.u.tau, setScale, params.get('autozoom') === '0' ? null : controls);

  // Follow the window size. Checked every frame rather than only on 'resize': a resize that happens while loading
  // (e.g. F11 / fullscreen during the shader compile) fires before any listener exists and left a gap at the bottom.
  // The scene renders into its own MSAA target (the occlusion culling reads its depth between the two tree phases),
  // then a fullscreen pass tone-maps it to the canvas.
  // (two outputs: colour, and the wind's screen motion of the trees for the anti-aliasing, see src/taa.js)
  const sceneRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true, count: 2 });
  sceneRT.textures[0].name = 'output';
  sceneRT.textures[1].name = 'wind';
  const sceneMRT = mrt({ output: colourOutput, wind: vec4(0) }); // (still everywhere but the trees)
  sceneMRT.setClearColor('wind', 0x000000, 0);
  sceneRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  // light shafts through the canopy (src/godrays.js; R or ?rays=0), added to the scene before the TAA resolve
  const rays = new GodRays(renderer, sceneRT.depthTexture, sunDir, { enabled: params.get('rays') !== '0' });
  // temporal anti-aliasing (src/taa.js): the output shows its resolved history
  const taa = new TAA(renderer, sceneRT, samples, { enabled: params.get('taa') !== '0', extra: rays.at });
  // (alpha 1: alpha-to-coverage leaves leave alpha < 1 in the target, and the canvas would show the page through)
  const output = new THREE.RenderPipeline(renderer, vec4(taa.displayNode, 1));
  forest.setDepthSource(sceneRT.depthTexture, samples);
  forest.occlusionOn = params.get('occ') !== '0';

  // the canvas at the display's resolution, the scene at auto quality's (src/resolution.ts; the TAA upscales)
  const res = createResolution(renderer, camera, sceneRT, params);
  const size = res.render; // (the scene's pixels: what everything but the TAA resolve and the output works in)
  const fitToWindow = (): void => res.fit();
  fitToWindow();
  window.addEventListener('resize', fitToWindow);
  if (startScale < 1) setScale(startScale);

  // ---------------------------------------------------------------- frame
  const music = createMusic(params, HARNESS); // (ez-tree's birdsong, from the first click, tap or key)
  demo.music = music;
  let time = 0;
  const waypoint = createWaypoint(HARNESS && params.get('waypoint') !== '1');
  const compass = createCompass(waypoint.target, HARNESS && params.get('waypoint') !== '1');
  function frame(dt: number): void {
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
    // the software rasterizer only from SW_ALTITUDE up (down to 70% of it: no flipping at one height; see sw.idle)
    if (SW_ALTITUDE > 0) forest.sw.idle = altitude < (forest.sw.idle ? SW_ALTITUDE : SW_ALTITUDE * 0.7);
    // occlusion culling only up to OCC_ALTITUDE (to 130% of it): from above little hides anything and its passes cost
    forest.u.occlusion.value = forest.occlusionOn && altitude < OCC_ALTITUDE * (forest.u.occlusion.value ? 1.3 : 1) ? 1 : 0;
    fogFar.value = Math.min(70000, 4000 + altitude * 14);
    fogNear.value = Math.min(6000, 400 + altitude * 3);
    forest.u.maxDist.value = fogFar.value;

    fitShadowMap(size.x * size.y); // (before follow: it snaps the map to its texels)
    follow(camera, gy, demo.shadowShift);
    // (from high up the average shadow everywhere, no shadow pass: lighting.ts FAR_TEXEL)
    const castShadows = shadowFarOnly() ? false : shadowsOn;
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
  }

  // HUD and performance panel
  const hud = createHud({
    renderer, camera, controls, forest, taa, auto, size, output: res.output, samples, shadowsOn: () => shadowsOn,
    harness: HARNESS && params.get('perf') !== '1', // (?perf=1: the panel under the harness too)
    adapterName: [ai.vendor, ai.architecture, ai.description].filter(Boolean).join(' ') || 'unknown adapter',
  });
  const updateHud = hud.update;
  demo.perfReport = () => hud.perf?.report();
  demo.hud = hud;
  // GPU profile (src/profile.ts): the panel's PROFILE button, demo.profile() for the harness
  const profile = (): Promise<string> => runProfile(
    { auto, forest, taa, rays, clouds: clouds.group, grass: grass.group, terrain: [terrain, sky], shadowsOn: () => shadowsOn, setShadows, setScale },
    (label, i, n) => hud.perf?.status(`PROFILING ${i + 1}/${n}: ${label.toUpperCase()}`),
  );
  demo.profile = profile;
  // settings menu + keyboard shortcuts (src/menu.ts)
  createMenu({ controls, forest, taa, rays, clouds: clouds.group, grass: grass.group, auto, perf: hud.perf, music, shadowsOn: () => shadowsOn, setShadows, setScale, profile, touch: Boolean(touch) });

  let prev = performance.now();
  function loop() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    frame(dt);
    autoQuality(dt);
    hud.frame(now, dt);
  }

  // ---------------------------------------------------------------- harness API
  installHarnessApi(demo, {
    renderer, sceneRT, scene, camera, forest, controls, adapter, instances, buildMs, size, auto, frame, loop, setShadows, setScale, updateHud,
    shadowsOn: () => shadowsOn,
    setBenchMs: (m) => hud.setBenchMs(m),
  });

  // Compile everything before revealing. three.js builds a material's shaders the first time it draws it, which
  // blocks the main thread; drawing one group of objects at a time (the rest hidden) lets the status line and the
  // bar move between groups. The last step, a real frame, compiles the culling compute passes.
  const tc = performance.now();
  const byName = (prefix: string): THREE.Object3D[] => forest.group.children.filter((o) => o.name.startsWith(prefix));
  const warm: [string, THREE.Object3D[]][] = [
    ['terrain and sky', [terrain, sky]],
    ['bark', byName('nanite-bark')],
    ['leaves', byName('nanite-leaves')],
    ['impostors', byName('nanite-impostors')],
    ['software rasterizer resolve', byName('nanite-software-resolve')],
    ['clouds', [clouds.group]],
  ];
  const all = [terrain, sky, clouds.group, ...forest.group.children];
  const wasVisible = all.map((o) => o.visible);
  fitToWindow();
  renderer.setRenderTarget(sceneRT);
  renderer.setMRT(sceneMRT);
  camera.layers.set(0);
  camera.layers.enable(PHASE2_LAYER);
  for (let k = 0; k < warm.length; k++) {
    const [label, objects] = warm[k];
    await ui.update(0.84 + (0.09 * k) / warm.length, `Compiling shaders: ${label}`, false);
    const t = performance.now();
    all.forEach((o, i) => (o.visible = wasVisible[i] && objects.includes(o)));
    sun.shadow.needsUpdate = shadowsOn; // (the shadow-map versions of the casters too)
    renderer.render(scene, camera);
    ui.note(`Compiled ${label} (${Math.round(performance.now() - t)} ms)`);
  }
  all.forEach((o, i) => (o.visible = wasVisible[i]));
  camera.layers.set(0);
  renderer.setMRT(null);
  renderer.setRenderTarget(null);
  // the compute passes, one stage at a time (each compiles on its first dispatch)
  fitToWindow();
  follow(camera, heightAt(camera.position.x, camera.position.z), demo.shadowShift);
  const computeSteps: [string, () => void][] = [
    ['culling', () => forest.update(camera, size, 0, shadowsOn ? sun.shadow.camera : null)],
    ['occlusion', () => forest.occlusion(camera, size.x, size.y)],
    ['software rasterizer', () => forest.rasterize(camera, size.x, size.y)],
    ['the first frame', () => frame(0)],
  ];
  for (let k = 0; k < computeSteps.length; k++) {
    const [label, run] = computeSteps[k];
    await ui.update(0.93 + (0.06 * k) / computeSteps.length, `Compiling shaders: ${label}`, false);
    const t = performance.now();
    run();
    await gpuBackend(renderer).device.queue.onSubmittedWorkDone();
    ui.note(`Compiled ${label} (${Math.round(performance.now() - t)} ms)`);
  }
  ui.note(`First frame ready (${Math.round(performance.now() - tc)} ms)`);
  await ui.reveal();
  if (!HARNESS) renderer.setAnimationLoop(loop);
  demo.ready = true;
}

start().catch((e) => {
  console.error(e);
  demo.error = String(e instanceof Error ? (e.stack ?? e) : e);
  ui.fail(e);
});
