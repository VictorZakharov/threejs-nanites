import * as THREE from 'three/webgpu';
import { float, select, uint } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { createTerrain, heightAt } from './terrain.js';
import { buildAllTrees, VARIANTS } from './trees.js';
import { NaniteForest } from './nanite.js';
import { FlyControls } from './controls.js';

const params = new URLSearchParams(location.search);
const HARNESS = params.has('harness');
const TREE_COUNT = Number(params.get('trees') ?? 10000);
if (HARNESS) document.body.classList.add('harness');

const demo = (window.__demo = { ready: false, error: null });
const loadMsg = document.getElementById('loadmsg');
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

/** Stacks images into one mipmapped DataArrayTexture (so one draw can sample any tree's texture). */
async function arrayTexture(urls, size, fillTransparent = false) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = new Uint8Array(size * size * 4 * urls.length);
  const imgs = await Promise.all(urls.map(loadImage));
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
function placeTrees(count) {
  const rnd = mulberry32(42);
  const spacing = 9;
  const radius = Math.sqrt((count * spacing * spacing) / Math.PI) * 1.15;
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
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser (try Chrome or Edge).');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter.');
  const lim = adapter.limits;
  if (lim.maxStorageBuffersPerShaderStage < 10) throw new Error('GPU supports too few storage buffers per stage.');
  const renderer = new THREE.WebGPURenderer({
    antialias: params.get('aa') !== '0',
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
  const pixelRatio = Number(params.get('pr') ?? Math.min(window.devicePixelRatio, 1.5));
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = params.get('shadows') !== '0';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 6000);

  // sky + sun
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(215));
  const sky = new SkyMesh();
  sky.scale.setScalar(5000);
  sky.turbidity.value = 4;
  sky.rayleigh.value = 1.2;
  sky.mieCoefficient.value = 0.004;
  sky.mieDirectionalG.value = 0.85;
  sky.sunPosition.value.copy(sunDir);
  sky.material.fog = false;
  scene.add(sky);

  const fogColor = new THREE.Color(0xa9bccb);
  scene.fog = new THREE.Fog(fogColor, 250, 2600);

  const hemi = new THREE.HemisphereLight(0xbcd3ec, 0x4a4632, 1.3);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sun.castShadow = true;
  const smap = Number(params.get('smap') ?? 2048);
  sun.shadow.mapSize.set(smap, smap);
  const SH = 110;
  Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 800 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  sun.shadow.camera.layers.set(1); // the forest has dedicated (coarser, light-culled) shadow-caster meshes on layer 1
  scene.add(sun, sun.target);

  scene.add(createTerrain());

  // trees
  const t0 = performance.now();
  const trees = await buildAllTrees((d, n) => (loadMsg.textContent = `Building cluster DAGs… ${d}/${n}`));
  const buildMs = performance.now() - t0;
  loadMsg.textContent = 'Uploading…';

  const barkTypes = ['oak', 'birch', 'pine'];
  const leafTypes = ['oak', 'ash', 'aspen', 'pine'];
  const [barkTex, leafTex] = await Promise.all([
    arrayTexture(barkTypes.map((t) => `./textures/${t}_color_1k.jpg`), 1024),
    arrayTexture(leafTypes.map((t) => `./textures/${t}_color.png`), 1024, true),
  ]);
  barkTex.colorSpace = leafTex.colorSpace = THREE.SRGBColorSpace;
  leafTex.wrapS = leafTex.wrapT = THREE.ClampToEdgeWrapping;

  const instances = placeTrees(TREE_COUNT);
  const forest = new NaniteForest(renderer, trees, instances, {
    bark: barkTex,
    leaf: leafTex,
    barkLayerOf: layerLookup(VARIANTS.map((v) => barkTypes.indexOf(v.bark))),
    leafLayerOf: layerLookup(VARIANTS.map((v) => leafTypes.indexOf(v.leaf))),
  });
  forest.u.tau.value = Number(params.get('tau') ?? 1.5);
  forest.u.debug.value = Number(params.get('debug') ?? 0);
  scene.add(forest.group);

  // camera + controls
  const controls = new FlyControls(camera, renderer.domElement);
  camera.position.set(20, heightAt(20, 40) + 1.8, 40);
  controls.yaw = THREE.MathUtils.degToRad(30);
  controls.pitch = THREE.MathUtils.degToRad(4);

  function setShadows(on) {
    renderer.shadowMap.enabled = on;
    sun.castShadow = on;
    scene.traverse((o) => o.material && (o.material.needsUpdate = true));
  }
  setShadows(renderer.shadowMap.enabled);

  // Auto quality: steer the error threshold so the GPU frame time stays within budget (manual [ ] turns it off).
  const auto = { on: params.get('auto') !== '0' && !HARNESS, budget: Number(params.get('budget') ?? 8), gpuMs: 0, busy: false };
  function autoQuality(dt) {
    const tau = forest.u.tau;
    const step = (over) => {
      if (over > 1.05) tau.value = Math.min(8, tau.value * Math.min(1.25, over));
      else if (over < 0.7) tau.value = Math.max(1, tau.value / 1.04);
    };
    if (!renderer.backend.trackTimestamp) {
      // no timestamp queries: fall back to frame time against 60 fps
      if (auto.on) step(dt * 1000 / 16.7);
      return;
    }
    if (auto.busy) return;
    auto.busy = true;
    Promise.all([renderer.resolveTimestampsAsync('render'), renderer.resolveTimestampsAsync('compute')]).then(([r, c]) => {
      auto.busy = false;
      if (!(r >= 0)) return;
      const g = r + (c || 0);
      auto.gpuMs = auto.gpuMs ? auto.gpuMs * 0.85 + g * 0.15 : g;
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
    if (code === 'KeyP') setShadows(!renderer.shadowMap.enabled);
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
    camera.updateMatrixWorld();

    // shadow camera follows the view, snapped to texels so shadows don't shimmer
    const texel = (2 * SH) / sun.shadow.mapSize.x;
    const focus = camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), SH * 0.5);
    focus.y = heightAt(focus.x, focus.z);
    focus.x = Math.round(focus.x / texel) * texel;
    focus.z = Math.round(focus.z / texel) * texel;
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(sunDir, 400);

    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);

    renderer.getDrawingBufferSize(size);
    forest.update(camera, size.y, time, renderer.shadowMap.enabled ? sun.shadow.camera : null);
    renderer.render(scene, camera);
  }

  // HUD
  let frames = 0, acc = 0, last = performance.now(), fps = 0, ms = 0, gs = null;
  async function updateHud() {
    gs = await forest.readStats();
    const tris = gs.barkTris + gs.leafTris;
    hud.textContent =
      `${fps.toFixed(0)} fps  ${ms.toFixed(2)} ms   gpu ${auto.gpuMs.toFixed(2)} ms\n` +
      `trees      ${gs.instances} / ${forest.instanceCount} visible\n` +
      `clusters   ${(gs.barkClusters + gs.leafClusters).toLocaleString()} (bark ${gs.barkClusters.toLocaleString()}, leaf ${gs.leafClusters.toLocaleString()})\n` +
      `triangles  ${(tris / 1e6).toFixed(2)} M\n` +
      `error      ${forest.u.tau.value.toFixed(2)} px ${auto.on ? `(auto, ${auto.budget} ms budget)` : '(manual)'}${forest.frozen ? '   [CULLING FROZEN]' : ''}\n` +
      `debug      ${['off', 'clusters', 'DAG level', 'trees'][forest.u.debug.value]}   shadows ${renderer.shadowMap.enabled ? 'on' : 'off'}`;
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
        shadowTris: renderer.shadowMap.enabled ? sh.barkTris + sh.leafTris : 0,
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

  // compile everything before revealing
  frame(0);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  document.getElementById('loading').classList.add('done');
  if (!HARNESS) renderer.setAnimationLoop(loop);
  demo.ready = true;
}

start().catch((e) => {
  console.error(e);
  demo.error = String(e?.stack ?? e);
  loadMsg.textContent = 'Error: ' + (e?.message ?? e);
});
