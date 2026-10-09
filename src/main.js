import * as THREE from 'three/webgpu';
import { Fn, attribute, float, max, abs, mix, positionWorld, cameraPosition, cubeTexture, fog, rangeFogFactor, select, smoothstep, texture, length, uint, uniform, vec3, vec4 } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { createTerrain, heightAt } from './terrain.js';
import { buildAllTrees, VARIANTS } from './trees.js';
import { NaniteForest, makeLeafAlpha } from './nanite.js';
import { bakeImpostors, impostorCoverage, IMPOSTOR_CUT } from './impostors.js';
import { viewerPos } from './planet.js';
import { createClouds, CLOUD_BASE } from './clouds.js';
import { FlyControls } from './controls.js';
import { LoadingScreen } from './loading.js';

const params = new URLSearchParams(location.search);
const HARNESS = params.has('harness');
const TREE_COUNT = Number(params.get('trees') ?? 1000000);
if (HARNESS) document.body.classList.add('harness');

// shadowShift: debug offset of the shadow-map centre (harness sweeps)
const demo = (window.__demo = { ready: false, error: null, shadowShift: new THREE.Vector3() });
const ui = new LoadingScreen();
const hud = document.getElementById('hud');

// ---------------------------------------------------------------- helpers
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/**
 * Coverage-preserving alpha for alpha-tested foliage: for each mip level (2x2 box filter, as the GPU builds them),
 * the scale that keeps the same fraction of texels above the 0.5 cut-off as the full-size image. Without it a leaf
 * card thins out (or, with a crude boost, thickens) depending on its mip, so a tree's density and brightness jump
 * when its LOD swaps to fewer, bigger cards, and distant canopies speckle.
 */
function coverageScales(px, size, levels) {
  let a = new Float32Array(size * size);
  for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3] / 255;
  let target = 0;
  for (const v of a) if (v > 0.5) target++;
  target /= a.length;
  const scales = [1];
  let w = size;
  for (let l = 1; l < levels; l++) {
    const h = w >> 1;
    const b = new Float32Array(h * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < h; x++)
        b[y * h + x] = (a[2 * y * w + 2 * x] + a[2 * y * w + 2 * x + 1] + a[(2 * y + 1) * w + 2 * x] + a[(2 * y + 1) * w + 2 * x + 1]) / 4;
    a = b;
    w = h;
    // alpha value at the (1 - target) quantile becomes the new 0.5
    const sorted = Float32Array.from(a).sort();
    const q = sorted[Math.min(sorted.length - 1, Math.floor((1 - target) * sorted.length))];
    scales.push(Math.min(8, 0.5 / Math.max(q, 1e-3)));
  }
  return scales;
}

/** Stacks images into one mipmapped DataArrayTexture (so one draw can sample any tree's texture). */
async function arrayTexture(urls, size, fillTransparent = false) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = new Uint8Array(size * size * 4 * urls.length);
  const imgs = await Promise.all(urls.map(loadImage));
  const alphaScales = [];
  imgs.forEach((img, i) => {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    if (fillTransparent) {
      // transparent texels are white in these PNGs; mipmapping would bleed that into the leaf edges as a pale halo,
      // so give them the average leaf colour instead
      let r = 0, g = 0, b = 0, n = 0;
      for (let p = 0; p < px.length; p += 4) if (px[p + 3] > 128) { r += px[p]; g += px[p + 1]; b += px[p + 2]; n++; }
      r /= n; g /= n; b /= n;
      for (let p = 0; p < px.length; p += 4) if (px[p + 3] < 128) { px[p] = r; px[p + 1] = g; px[p + 2] = b; }
    }
    if (fillTransparent) alphaScales.push(...coverageScales(px, size, Math.log2(size) + 1));
    data.set(px, i * size * size * 4);
  });
  const tex = new THREE.DataArrayTexture(data, size, size, urls.length);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.userData.alphaScales = alphaScales; // per layer, per mip level
  tex.userData.levels = Math.log2(size) + 1;
  return tex;
}

/** Maps a tree type (uint node) to a texture layer via a select chain. */
function layerLookup(layers) {
  return (type) => {
    let node = float(layers[layers.length - 1]);
    for (let i = layers.length - 2; i >= 0; i--) node = select(type.equal(uint(i)), float(layers[i]), node);
    return node;
  };
}

/** Scatters trees over the hills: jittered grid, noisy clearings, pines higher up. */
const TREE_SPACING = 9;
const MAX_ALTITUDE = 9000;
/** Radius (m) of the forest disc for `count` trees. */
const forestRadius = (count) => Math.sqrt((count * TREE_SPACING * TREE_SPACING) / Math.PI) * 1.15;

/** Canopy cover (0..1) of the ground on a grid over the forest, for the far-field ground darkening. */
function forestDensity({ a, radius }) {
  const N = 1024, extent = radius * 1.8, cell = (extent * 2) / N;
  const cov = new Float32Array(N * N);
  const crown = Number(params.get('crown') ?? 100) / (cell * cell); // ~60 m^2 of shade per tree (scaled by tree size; low sun: long shadows)
  for (let i = 0; i < a.length; i += 4) {
    const x = Math.floor((a[i] / (extent * 2) + 0.5) * N), z = Math.floor((a[i + 2] / (extent * 2) + 0.5) * N);
    if (x >= 0 && z >= 0 && x < N && z < N) cov[z * N + x] += crown * a[i + 3] * a[i + 3];
  }
  // two box blurs (~ a few tens of metres), then clamp to full cover
  let src = cov, dst = new Float32Array(N * N);
  for (let pass = 0; pass < 4; pass++) {
    const horiz = pass % 2 === 0;
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        let sum = 0;
        for (let k = -2; k <= 2; k++) {
          const xx = horiz ? Math.min(N - 1, Math.max(0, x + k)) : x, zz = horiz ? z : Math.min(N - 1, Math.max(0, z + k));
          sum += src[zz * N + xx];
        }
        dst[z * N + x] = sum / 5;
      }
    [src, dst] = [dst, src];
  }
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) data[i * 4] = Math.round(Math.min(1, src[i]) * 255);
  const tex = new THREE.DataTexture(data, N, N);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { texture: tex, extent };
}

function placeTrees(count) {
  const rnd = mulberry32(42);
  const radius = forestRadius(count);
  const a = [], b = [];
  const pineTypes = VARIANTS.map((v, i) => (v.preset.startsWith('Pine') ? i : -1)).filter((i) => i >= 0);
  const leafTypes = VARIANTS.map((v, i) => (v.preset.startsWith('Pine') ? -1 : i)).filter((i) => i >= 0);
  let tries = 0;
  while (a.length / 4 < count && tries++ < count * 20) {
    const ang = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius * 1.35;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    // ragged forest edge: the boundary radius wobbles with the angle, and density fades out past it
    const edge = radius * (1 + 0.22 * Math.sin(ang * 3 + 0.7) + 0.12 * Math.sin(ang * 7 - 1.9) + 0.06 * Math.sin(ang * 13));
    if (r > edge && rnd() > Math.exp(-(r - edge) / 35)) continue;
    if (Math.hypot(x - 20, z - 40) < 14) continue; // keep the spawn point clear
    // clearings
    const clearing = Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.013 - 0.7) + Math.sin(x * 0.031 + z * 0.027) * 0.4;
    if (clearing > 0.75 && rnd() < 0.9) continue;
    const y = heightAt(x, z);
    const pineBias = THREE.MathUtils.smoothstep(y, -10, 30) * 0.7 + (Math.sin(x * 0.004 - z * 0.006) * 0.5 + 0.5) * 0.4;
    const pool = rnd() < pineBias ? pineTypes : leafTypes;
    const type = pool[Math.floor(rnd() * pool.length)];
    const scale = 0.75 + rnd() * 0.5;
    const rot = rnd() * Math.PI * 2;
    a.push(x, y - 0.3, z, scale);
    b.push(Math.cos(rot), Math.sin(rot), type, rnd() * 6.28);
  }
  return { a: new Float32Array(a), b: new Float32Array(b), radius };
}

// ---------------------------------------------------------------- setup
async function start() {
  await ui.update(0.02, 'Waking the GPU');
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser (try Chrome or Edge).');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter.');
  const lim = adapter.limits;
  if (lim.maxStorageBuffersPerShaderStage < 10) throw new Error('GPU supports too few storage buffers per stage.');
  const renderer = new THREE.WebGPURenderer({
    antialias: params.get('aa') !== '0',
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
  if (HARNESS) sky.cloudSpeed.value = 0; // still clouds: frame-to-frame comparisons only see the forest
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
  const viewDir = positionWorld.sub(cameraPosition).normalize();
  const horizonDir = vec3(viewDir.x, max(viewDir.y, 0.015), viewDir.z).normalize();
  scene.fogNode = fog(cubeTexture(skyCube.texture, horizonDir).level(2).rgb, rangeFogFactor(fogNear, fogFar));

  const hemi = new THREE.HemisphereLight(0xbcd3ec, 0x4a4632, 1.3);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sun.castShadow = true;
  const smap = Number(params.get('smap') ?? 2048);
  sun.shadow.mapSize.set(smap, smap);
  // One shadow map that follows the view. Its half-extent grows with altitude (in steps, so texels don't crawl),
  // and receivers fade the shadow out towards its edge, so there's no hard "shadow stops here" line.
  let SH = 0;
  function setShadowExtent(h) {
    if (h === SH) return;
    SH = h;
    Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 1600 });
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
  // The same goes where the trees are impostors (which cast no shadow): judged by the screen height of a typical
  // tree at the receiver's distance, against the impostor threshold. (Called once the forest exists.)
  const makeFadeShadow = (far) => Fn(([shadow]) => {
    const c = shadowMatrix.mul(vec4(positionWorld, 1)).xy;
    const edge = max(abs(c.x.sub(0.5)), abs(c.y.sub(0.5))).mul(2);
    const typicalPx = float(20).mul(forest.u.projScale).div(max(length(positionWorld.sub(cameraPosition)), 1));
    const impostors = smoothstep(forest.u.impostorPx.mul(1.1), forest.u.impostorPx.mul(0.7), typicalPx);
    const fade = max(max(smoothstep(0.75, 0.97, edge), impostors), farEverywhere);
    return mix(shadow, mix(float(1), far, farShadowOn), fade);
  });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  sun.shadow.camera.layers.set(1); // the forest has dedicated (coarser, light-culled) shadow-caster meshes on layer 1
  scene.add(sun, sun.target);

  await ui.update(0.04, 'Raising hills, sky and sun');
  // terrain reaches past the ragged forest edge (trees go out to 1.35 x radius) and the fog
  const terrainSize = Math.max(9000, Math.ceil(forestRadius(TREE_COUNT) * 2.7 + 3000));
  const terrain = createTerrain(terrainSize);
  scene.add(terrain);
  const clouds = createClouds();
  scene.add(clouds.group);
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
  forest.u.tau.value = Number(params.get('tau') ?? 1.5);
  forest.u.maxDist.value = fogFar.value; // beyond the fog a tree is invisible: don't even cull its clusters
  forest.u.debug.value = Number(params.get('debug') ?? 0);
  if (params.get('wind') === '0') forest.u.wind.value = 0;
  forest.group.traverse((o) => o.isMesh && !o.castShadow && (o.material.receivedShadowNode = makeFadeShadow(treeFarShadow)));
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
  });
  atlas.coverage = await impostorCoverage(renderer, atlas, IMPOSTOR_CUT);
  const impostorMesh = forest.buildImpostorMesh(atlas);
  impostorMesh.receiveShadow = true;
  impostorMesh.material.receivedShadowNode = makeFadeShadow(treeFarShadow);
  demo.atlas = atlas; // (for probes: the atlas can be read back and dumped)
  demo.renderer = renderer;
  impostorMesh.visible = params.get('imp') !== '0'; // (debug switch)
  if (params.has('imppx')) forest.u.impostorPx.value = Number(params.get('imppx'));
  forest.group.add(impostorMesh);
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
    if (code === 'KeyL') forest.u.debug.value = (forest.u.debug.value + 1) % 4;
    if (code === 'KeyF') forest.frozen = !forest.frozen;
    if (code === 'BracketLeft' || code === 'Minus') (auto.on = false), (forest.u.tau.value = Math.max(0.25, forest.u.tau.value / 1.5));
    if (code === 'BracketRight' || code === 'Equal') (auto.on = false), (forest.u.tau.value = Math.min(64, forest.u.tau.value * 1.5));
    if (code === 'KeyQ') auto.on = !auto.on;
    if (code === 'KeyP') setShadows(!shadowsOn);
    if (code === 'KeyG') forest.u.wind.value = forest.u.wind.value > 0 ? 0 : 1;
    if (code === 'KeyH') document.getElementById('help').classList.toggle('hidden', (showHelp = !showHelp) === false);
  };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------------------------------------------------------------- frame
  let time = 0;
  const size = new THREE.Vector2();
  function frame(dt) {
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

    // shadow map: centred on the ground the camera looks at, extent from altitude
    const agl = Math.max(0, camera.position.y - gy);
    setShadowExtent(Math.min(640, 110 * Math.pow(1.25, Math.max(0, Math.ceil(Math.log(1 + agl / 40) / Math.log(1.25))))));
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const reach = dir.y < -0.05 ? Math.min(SH * 0.9, agl / -dir.y) : SH * 0.5;
    const focus = camera.position.clone().addScaledVector(dir, reach).add(demo.shadowShift);
    focus.y = heightAt(focus.x, focus.z);
    // snap in light space (the sun is diagonal: snapping world x/z doesn't stop shimmer)
    const texel = (2 * SH) / sun.shadow.mapSize.x;
    const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize();
    const ly = new THREE.Vector3().crossVectors(sunDir, lx);
    const fx = Math.round(focus.dot(lx) / texel) * texel, fy = Math.round(focus.dot(ly) / texel) * texel, fz = focus.dot(sunDir);
    focus.copy(lx).multiplyScalar(fx).addScaledVector(ly, fy).addScaledVector(sunDir, fz);
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(sunDir, 800);

    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);

    renderer.getDrawingBufferSize(size);
    forest.update(camera, size.y, time, shadowsOn ? sun.shadow.camera : null);
    renderer.render(scene, camera);
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
      `triangles  ${(tris / 1e6).toFixed(2)} M\n` +
      `error      ${forest.u.tau.value.toFixed(2)} px ${auto.on ? `(auto, ${auto.budget} ms budget)` : '(manual)'}${forest.frozen ? '   [CULLING FROZEN]' : ''}\n` +
      `debug      ${['off', 'clusters', 'DAG level', 'trees'][forest.u.debug.value]}   shadows ${shadowsOn ? 'on' : 'off'}`;
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
  Object.assign(demo, {
    renderer, scene, camera, forest, controls,
    info: () => ({
      adapter: `${adapter.info?.vendor} ${adapter.info?.architecture} ${adapter.info?.description ?? ''}`.trim(),
      size: `${size.x}x${size.y}`,
      trees: forest.instanceCount,
      forestRadius: Math.round(instances.radius),
      dagBuildMs: Math.round(buildMs),
      ...forest.stats,
    }),
    setView(v) {
      let x = v.x, z = v.z, yaw = THREE.MathUtils.degToRad(v.yaw ?? 0), pitch = THREE.MathUtils.degToRad(v.pitch ?? 0);
      let y = v.y ?? heightAt(x, z) + (v.agl ?? 2);
      if (v.nearTree) {
        // look at the closest tree from `nearTree` metres away
        let best = 0, bd = Infinity;
        for (let i = 0; i < forest.instanceCount; i++) {
          const d = Math.hypot(instances.a[i * 4] - x, instances.a[i * 4 + 2] - z);
          if (d < bd) { bd = d; best = i; }
        }
        const tx = instances.a[best * 4], tz = instances.a[best * 4 + 2], ty = instances.a[best * 4 + 1];
        x = tx + Math.sin(yaw) * v.nearTree;
        z = tz + Math.cos(yaw) * v.nearTree;
        y = Math.max(heightAt(x, z) + 1.7, ty + (v.agl ?? 3));
        pitch = Math.atan2(ty + 6 - y, v.nearTree);
      }
      camera.position.set(x, y, z);
      controls.yaw = yaw;
      controls.pitch = pitch;
      controls.velocity.set(0, 0, 0);
    },
    async renderOnce(benchResult) {
      if (benchResult) { ms = benchResult.medianMs; fps = 1000 / ms; }
      frame(1 / 60);
      await updateHud();
      frame(1 / 60);
      await renderer.backend.device.queue.onSubmittedWorkDone();
    },
    stats: () => forest.readStats(),
    /** Harness sweeps: move one thing that normally follows the camera, keep the view fixed. */
    setShift(what, x, z) {
      forest.main.lodShift.set(0, 0, 0);
      forest.shadow.lodShift.set(0, 0, 0);
      demo.shadowShift.set(0, 0, 0);
      const t = { lod: forest.main.lodShift, shadowlod: forest.shadow.lodShift, shadow: demo.shadowShift }[what];
      t?.set(x, 0, z);
    },
    /** Times a shadow toggle off and on (each followed by a rendered frame). */
    async shadowToggleMs() {
      const out = [];
      for (const on of [false, true]) {
        const t = performance.now();
        setShadows(on);
        frame(1 / 60);
        await renderer.backend.device.queue.onSubmittedWorkDone();
        out.push(Math.round(performance.now() - t));
      }
      return out;
    },
    /** Runs the real loop (auto quality on, flying forward) for `ms`, reports where the controller settled. */
    async autoTest(ms = 5000, budget = auto.budget, speed = 10) {
      auto.on = true;
      auto.budget = budget;
      auto.gpuMs = 0;
      forest.u.tau.value = 1;
      const fwd = () => controls.keys.add('KeyW');
      controls.speed = speed;
      fwd();
      const t0 = performance.now();
      let n = 0;
      renderer.setAnimationLoop(() => {
        loop();
        n++;
      });
      await new Promise((r) => setTimeout(r, ms));
      renderer.setAnimationLoop(null);
      controls.keys.clear();
      return { tau: +forest.u.tau.value.toFixed(2), gpuMs: +auto.gpuMs.toFixed(2), fps: +((n * 1000) / (performance.now() - t0)).toFixed(1), budget };
    },
    async bench(n = 120) {
      const device = renderer.backend.device;
      const ts = renderer.backend.trackTimestamp;
      for (let i = 0; i < 5; i++) {
        frame(1 / 60); // warm up (pipelines compile on first use)
        await device.queue.onSubmittedWorkDone();
        if (ts) { await renderer.resolveTimestampsAsync('render'); await renderer.resolveTimestampsAsync('compute'); }
      }
      // 1) GPU time per frame from timestamp queries (render passes incl. shadows, and the culling compute)
      const gpuR = [], gpuC = [], cpu = [];
      for (let i = 0; ts && i < n; i++) {
        const t = performance.now();
        frame(1 / 60);
        cpu.push(performance.now() - t);
        gpuR.push(await renderer.resolveTimestampsAsync('render'));
        gpuC.push(await renderer.resolveTimestampsAsync('compute'));
      }
      // 2) throughput: frames pipelined like a real loop (max 2 in flight)
      const inflight = [];
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        if (inflight.length >= 2) await inflight.shift();
        frame(1 / 60);
        inflight.push(device.queue.onSubmittedWorkDone());
      }
      await Promise.all(inflight);
      const frameMs = (performance.now() - t0) / n;
      const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
      const s = await forest.readStats();
      const sh = await forest.readStats(forest.shadow);
      return {
        shadowTris: shadowsOn ? sh.barkTris + sh.leafTris : 0,
        frameMs,
        gpuRenderMs: med(gpuR),
        gpuComputeMs: med(gpuC),
        cpuMs: med(cpu),
        medianMs: frameMs,
        clusters: s.barkClusters + s.leafClusters,
        tris: s.barkTris + s.leafTris,
        instances: s.instances,
        ...s,
      };
    },
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
