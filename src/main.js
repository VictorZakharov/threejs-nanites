import * as THREE from 'three/webgpu';
import { Fn, attribute, float, mix, positionWorld, smoothstep, texture, uniform, vec4 } from 'three/tsl';
import { createTerrain, heightAt } from './terrain.js';
import { buildAllTrees, VARIANTS } from './trees.js';
import { NaniteForest } from './nanite/forest.js';
import { PHASE2_LAYER } from './nanite/constants.js';
import { makeLeafAlpha } from './nanite/shading.js';
import { bakeImpostors, impostorCoverage, IMPOSTOR_CUT } from './impostors.js';
import { viewerPos } from './planet.js';
import { createClouds, CLOUD_BASE } from './clouds.js';
import { FlyControls } from './controls.js';
import { LoadingScreen } from './loading.js';
import { arrayTexture, layerLookup } from './textures.js';
import { MAX_ALTITUDE, forestRadius, forestDensity, placeTrees } from './placement.js';
import { createLighting } from './lighting.js';
import { installHarnessApi } from './harness-api.js';

const params = new URLSearchParams(location.search);
const HARNESS = params.has('harness');
const TREE_COUNT = Number(params.get('trees') ?? 1000000);
if (HARNESS) document.body.classList.add('harness');

// shadowShift: debug offset of the shadow-map centre (harness sweeps)
const demo = (window.__demo = { ready: false, error: null, shadowShift: new THREE.Vector3() });
const ui = new LoadingScreen();
const hud = document.getElementById('hud');

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
      maxStorageBuffersPerShaderStage: lim.maxStorageBuffersPerShaderStage,
      maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
      maxBufferSize: lim.maxBufferSize,
    },
  });
  await renderer.init();
  if (!renderer.backend.isWebGPUBackend) throw new Error('WebGPU backend unavailable (got WebGL fallback).');
  const ai = adapter.info ?? {};
  ui.note(`WebGPU adapter: ${[ai.vendor, ai.architecture, ai.description].filter(Boolean).join(' ') || 'unknown'}`);
  const pixelRatio = Number(params.get('pr') ?? Math.min(window.devicePixelRatio, 1.5));
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  // Shadows stay compiled in; turning them "off" zeroes the intensity and skips the shadow pass. Toggling
  // renderer.shadowMap.enabled instead recompiles every shader (a ~10 s freeze).
  renderer.shadowMap.enabled = true;
  let shadowsOn = params.get('shadows') !== '0';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.3, 150000);

  const { sun, fogNear, fogFar, fogColour, skyCapture, cubeCam, makeFadeShadow, treeFarShadow, farShadowOn, follow } =
    createLighting(scene, { harness: HARNESS });

  await ui.update(0.04, 'Raising hills, sky and sun');
  // terrain reaches past the ragged forest edge (trees go out to 1.35 x radius) and the fog
  const terrainSize = Math.max(9000, Math.ceil(forestRadius(TREE_COUNT) * 2.7 + 3000));
  const terrain = createTerrain(terrainSize);
  scene.add(terrain);
  const clouds = createClouds();
  scene.add(clouds.group);
  clouds.group.traverse((o) => o.layers.set(PHASE2_LAYER)); // (transparent: drawn after both tree phases)
  clouds.group.visible = params.get('clouds') !== '0'; // (debug switch)

  // trees
  const t0 = performance.now();
  const trees = await buildAllTrees(ui);
  const buildMs = performance.now() - t0;
  await ui.update(0.77, 'Pressing leaves and bark into texture arrays');

  const barkTypes = ['oak', 'birch', 'pine'];
  const leafTypes = ['oak', 'ash', 'aspen', 'pine'];
  const [barkTex, leafTex] = await Promise.all([
    arrayTexture(barkTypes.map((t) => `./textures/${t}_color_1k.jpg`), 1024),
    arrayTexture(leafTypes.map((t) => `./textures/${t}_color.png`), 1024, true),
  ]);
  barkTex.colorSpace = leafTex.colorSpace = THREE.SRGBColorSpace;
  leafTex.wrapS = leafTex.wrapT = THREE.ClampToEdgeWrapping;

  await ui.update(0.8, `Scattering ${TREE_COUNT.toLocaleString()} trees`);
  const instances = placeTrees(TREE_COUNT);
  const forest = new NaniteForest(renderer, trees, instances, {
    bark: barkTex,
    leaf: leafTex,
    barkLayerOf: layerLookup(VARIANTS.map((v) => barkTypes.indexOf(v.bark))),
    leafLayerOf: layerLookup(VARIANTS.map((v) => leafTypes.indexOf(v.leaf))),
    alphaToCoverage: params.get('a2c') !== '0',
  });
  forest.u.tau.value = Number(params.get('tau') ?? 1);
  forest.u.maxDist.value = fogFar.value; // beyond the fog a tree is invisible: don't even cull its clusters
  forest.u.debug.value = Number(params.get('debug') ?? 0);
  if (params.get('wind') === '0') forest.u.wind.value = 0;
  forest.group.traverse((o) => o.isMesh && !o.castShadow && (o.material.receivedShadowNode = makeFadeShadow(treeFarShadow)));
  // software-rasterized tiny clusters: shaded per pixel from the visibility buffer, with the same shadows and fog
  forest.group.add(forest.sw.buildResolveMesh({
    fadeShadow: (pos) => makeFadeShadow(treeFarShadow, pos),
    fog: (pos, viewZ) => ({ color: fogColour(pos), factor: smoothstep(fogNear, fogFar, viewZ) }),
  }));
  // ground: darkened by how much canopy stands over it
  const density = forestDensity(instances);
  const groundShade = uniform(Number(params.get('groundshade') ?? 0.7));
  const cover = texture(density.texture, positionWorld.xz.div(density.extent * 2).add(0.5)).r;
  const groundFar = float(1).sub(cover.mul(groundShade));
  for (const m of terrain.userData.materials) m.receivedShadowNode = makeFadeShadow(groundFar);
  scene.add(forest.group);

  await ui.update(0.82, 'Baking far-field impostors and the sky');
  cubeCam.update(renderer, skyCapture);
  const atlas = bakeImpostors(renderer, trees, {
    bark: barkTex,
    leaf: leafTex,
    barkLayers: VARIANTS.map((v) => barkTypes.indexOf(v.bark)),
    leafLayers: VARIANTS.map((v) => leafTypes.indexOf(v.leaf)),
    leafAlpha: makeLeafAlpha(leafTex, attribute('uv', 'vec2')),
  }, Number(params.get('bakepx') ?? forest.u.impostorPx.value)); // (the default switch size, before ?imppx=)
  atlas.coverage = await impostorCoverage(renderer, atlas, IMPOSTOR_CUT);
  const impostorMesh = forest.buildImpostorMesh(atlas, VARIANTS.map((v) => v.impGain));
  impostorMesh.receiveShadow = true;
  // an impostor looks the map up on its sun side (the neighbours' shadows), its own crown's shade is the average
  const impFade = makeFadeShadow(treeFarShadow);
  impostorMesh.material.receivedShadowNode = Fn(([shadow]) => impFade(shadow.mul(mix(float(1), treeFarShadow, farShadowOn))));
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

  function setShadows(on) {
    shadowsOn = on;
    sun.shadow.intensity = on ? 1 : 0;
    farShadowOn.value = on ? 1 : 0;
    sun.shadow.autoUpdate = on;
    sun.shadow.needsUpdate = true; // one last pass (empty when off: the casters are hidden)
    forest.group.traverse((o) => o.isMesh && o.castShadow && (o.visible = on));
  }
  setShadows(shadowsOn);

  // Auto quality: steer the error threshold so the GPU frame time stays within budget (manual [ ] turns it off).
  const auto = { on: params.get('auto') !== '0' && !HARNESS, budget: Number(params.get('budget') ?? 8), gpuMs: 0, busy: false };
  // Changes are slow and have a dead band: every change of tau re-cuts the LOD of every tree on screen, so a
  // controller that twitches every frame makes the whole forest shimmer.
  let lastAdjust = 0;
  function autoQuality(dt) {
    const tau = forest.u.tau;
    const step = (over) => {
      const now = performance.now();
      if (now - lastAdjust < 500) return;
      if (over > 1.1) tau.value = Math.min(8, tau.value * Math.min(1.3, over));
      else if (over < 0.6) tau.value = Math.max(1, tau.value / 1.1);
      else return;
      lastAdjust = now;
    };
    if (!renderer.backend.trackTimestamp) {
      // no timestamp queries: fall back to frame time against 60 fps
      auto.frameMs = auto.frameMs ? auto.frameMs * 0.95 + dt * 50 : dt * 1000;
      if (auto.on) step(auto.frameMs / 16.7);
      return;
    }
    if (auto.busy) return;
    auto.busy = true;
    Promise.all([renderer.resolveTimestampsAsync('render'), renderer.resolveTimestampsAsync('compute')]).then(([r, c]) => {
      auto.busy = false;
      if (!(r >= 0)) return;
      const g = r + (c || 0);
      auto.gpuMs = auto.gpuMs ? auto.gpuMs * 0.9 + g * 0.1 : g;
      if (auto.on) step(auto.gpuMs / auto.budget);
    });
  }

  let showHelp = true;
  controls.onKey = (code) => {
    if (code === 'KeyL') forest.u.debug.value = (forest.u.debug.value + 1) % 6;
    if (code === 'KeyF') forest.frozen = !forest.frozen;
    if (code === 'BracketLeft' || code === 'Minus') (auto.on = false), (forest.u.tau.value = Math.max(0.25, forest.u.tau.value / 1.5));
    if (code === 'BracketRight' || code === 'Equal') (auto.on = false), (forest.u.tau.value = Math.min(64, forest.u.tau.value * 1.5));
    if (code === 'KeyQ') auto.on = !auto.on;
    if (code === 'KeyP') setShadows(!shadowsOn);
    if (code === 'KeyG') forest.u.wind.value = forest.u.wind.value > 0 ? 0 : 1;
    if (code === 'KeyH') document.getElementById('help').classList.toggle('hidden', (showHelp = !showHelp) === false);
  };

  // Follow the window size. Checked every frame rather than only on 'resize': a resize that happens while loading
  // (e.g. F11 / fullscreen during the shader compile) fires before any listener exists and left a gap at the bottom.
  // The scene renders into its own MSAA target (the occlusion culling reads its depth between the two tree phases),
  // then a fullscreen pass tone-maps it to the canvas.
  const samples = params.get('aa') === '0' ? 1 : 4;
  const sceneRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true });
  sceneRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  // (alpha 1: alpha-to-coverage leaves leave alpha < 1 in the target, and the canvas would show the page through)
  const output = new THREE.RenderPipeline(renderer, vec4(texture(sceneRT.texture).rgb, 1));
  forest.setDepthSource(sceneRT.depthTexture, samples);
  forest.u.occlusion.value = params.get('occ') === '0' ? 0 : 1;

  const viewSize = new THREE.Vector2();
  function fitToWindow() {
    renderer.getSize(viewSize);
    const w = window.innerWidth, h = window.innerHeight;
    if (viewSize.x !== w || viewSize.y !== h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    renderer.getDrawingBufferSize(size);
    if (sceneRT.width !== size.x || sceneRT.height !== size.y) sceneRT.setSize(size.x, size.y);
  }
  window.addEventListener('resize', fitToWindow);

  // ---------------------------------------------------------------- frame
  let time = 0;
  const size = new THREE.Vector2();
  function frame(dt) {
    fitToWindow();
    time += dt;
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
    camera.updateMatrixWorld();

    // view distance: the higher you fly, the further you see (fog thins), up to just inside the terrain's edge
    const altitude = Math.max(0, camera.position.y - gy);
    fogFar.value = Math.min(70000, 4000 + altitude * 14);
    fogNear.value = Math.min(6000, 400 + altitude * 3);
    forest.u.maxDist.value = fogFar.value;

    follow(camera, gy, demo.shadowShift);

    renderer.getDrawingBufferSize(size);
    forest.update(camera, size, time, shadowsOn ? sun.shadow.camera : null);
    // phase 1: terrain, sky and the trees visible last frame (+ the shadow map)
    renderer.setRenderTarget(sceneRT);
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
    renderer.setRenderTarget(null);
    output.render();
  }

  // HUD
  let frames = 0, acc = 0, last = performance.now(), fps = 0, ms = 0, gs = null;
  async function updateHud() {
    gs = await forest.readStats();
    const tris = gs.barkTris + gs.leafTris;
    hud.textContent =
      `${fps.toFixed(0)} fps  ${ms.toFixed(2)} ms   gpu ${auto.gpuMs.toFixed(2)} ms\n` +
      `trees      ${(gs.instances + gs.impostors).toLocaleString()} / ${forest.instanceCount.toLocaleString()} visible (${gs.impostors.toLocaleString()} as impostors)\n` +
      `altitude   ${Math.round(camera.position.y - heightAt(camera.position.x, camera.position.z))} m   speed ${Math.round(controls.velocity.length())} m/s\n` +
      `clusters   ${(gs.barkClusters + gs.leafClusters).toLocaleString()} (bark ${gs.barkClusters.toLocaleString()}, leaf ${gs.leafClusters.toLocaleString()})\n` +
      `triangles  ${(tris / 1e6).toFixed(2)} M   + ${((gs.swTris ?? 0) / 1e6).toFixed(2)} M in software (${(gs.swClusters ?? 0).toLocaleString()} clusters)\n` +
      `error      ${forest.u.tau.value.toFixed(2)} px ${auto.on ? `(auto, ${auto.budget} ms budget)` : '(manual)'}${forest.frozen ? '   [CULLING FROZEN]' : ''}\n` +
      `debug      ${['off', 'clusters', 'DAG level', 'trees', 'tree types', 'rasterizer'][forest.u.debug.value]}   shadows ${shadowsOn ? 'on' : 'off'}`;
  }

  let prev = performance.now();
  function loop() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    frame(dt);
    autoQuality(dt);
    frames++;
    acc += dt;
    if (now - last > 500) {
      fps = frames / acc;
      ms = (acc / frames) * 1000;
      frames = 0;
      acc = 0;
      last = now;
      updateHud();
    }
  }

  // ---------------------------------------------------------------- harness API
  installHarnessApi(demo, {
    renderer, scene, camera, forest, controls, adapter, instances, buildMs, size, auto, frame, loop, setShadows, updateHud,
    shadowsOn: () => shadowsOn,
    setBenchMs: (m) => { ms = m; fps = 1000 / m; },
  });

  // compile everything before revealing (synchronous and slow: the bar eases on the compositor meanwhile)
  await ui.beginLongStage(0.84, 0.97, 'Compiling shaders', 3500);
  const tc = performance.now();
  frame(0);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  ui.note(`First frame ready (${Math.round(performance.now() - tc)} ms)`);
  await ui.reveal();
  if (!HARNESS) renderer.setAnimationLoop(loop);
  demo.ready = true;
}

start().catch((e) => {
  console.error(e);
  demo.error = String(e?.stack ?? e);
  ui.fail(e);
});
