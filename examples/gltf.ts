// The library on its own (src/nanite-lib/, through its index only): a glTF mesh (rock.glb: ez-tree's rock1.glb, MIT,
// Daniel Greenheck, its Draco geometry decoded and only its colour map kept) as a Nanite type, 250k instances of
// it over a few kilometres, drawn by the GPU-driven renderer with its DAG cut, two-phase occlusion, software
// rasterizer and impostors, under a sun with shadows. No forest, planet, wind or demo code: the default look.
import * as THREE from 'three/webgpu';
import { Fn, texture, attribute, float, vec3, smoothstep } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  NaniteRenderer, buildDag, createAtlas, bakeImpostors, impostorCoverage, makeLeafAlpha, defaultLook,
  IMPOSTOR_CUT, PHASE2_LAYER, type NaniteType, type NaniteTextures, type Float, type Vec3,
} from '../src/nanite-lib/index.ts';

const SIDE = 500; // instances a side
const SPACING = 8; // m
const HEIGHT = 1.5; // m: the mesh's height at scale 1
const SKY = new THREE.Color(0x9fb8cf);
const info = document.getElementById('info')!;

// ---------------------------------------------------------------- the mesh: positions, normals, uvs, triangles
async function loadMesh(url: string): Promise<{ pos: Float32Array; nrm: Float32Array; uv: Float32Array; idx: Uint32Array; image: CanvasImageSource }> {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld();
  let found: { g: THREE.BufferGeometry; image: CanvasImageSource } | null = null;
  gltf.scene.traverse((o) => {
    const m = o as unknown as { isMesh?: boolean; geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial; matrixWorld: THREE.Matrix4 };
    if (m.isMesh && !found) found = { g: m.geometry.clone().applyMatrix4(m.matrixWorld), image: m.material.map!.image as CanvasImageSource };
  });
  if (!found) throw new Error(`${url}: no mesh`);
  const { g, image } = found as { g: THREE.BufferGeometry; image: CanvasImageSource };
  const pos = Float32Array.from(g.getAttribute('position').array as ArrayLike<number>);
  const nrm = Float32Array.from(g.getAttribute('normal').array as ArrayLike<number>);
  const uv = Float32Array.from(g.getAttribute('uv').array as ArrayLike<number>);
  const idx = Uint32Array.from(g.getIndex()!.array as ArrayLike<number>);
  // stood on its base, centred on its vertical axis, HEIGHT tall
  const box = new THREE.Box3().setFromArray(pos), s = HEIGHT / (box.max.y - box.min.y);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = (pos[i] - cx) * s;
    pos[i + 1] = (pos[i + 1] - box.min.y) * s;
    pos[i + 2] = (pos[i + 2] - cz) * s;
  }
  return { pos, nrm, uv, idx, image };
}

/** One layer of an array texture from an image (the renderer samples each type's layer of an array). */
function arrayOf(image: CanvasImageSource | null, size: number, alpha = 255): THREE.DataArrayTexture {
  const c = new OffscreenCanvas(size, size), g = c.getContext('2d')!;
  if (image) g.drawImage(image, 0, 0, size, size);
  const px = new Uint8Array(g.getImageData(0, 0, size, size).data.buffer);
  if (!image) px.fill(alpha);
  const tex = new THREE.DataArrayTexture(px, size, size, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.userData.levels = Math.log2(size) + 1;
  tex.userData.alphaScales = new Array(tex.userData.levels).fill(1); // (no cards: coverageScales in alpha.ts otherwise)
  return tex;
}

async function main(): Promise<void> {
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  await renderer.init();
  if (!(renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error('this example needs WebGPU (compute)');
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // (the clear colour, not scene.background: a colour background clears the target again in the phase 2 render)
  renderer.setClearColor(SKY);
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.3, 6000);
  camera.position.set(-12, 6, -12);
  const controls = new OrbitControls(camera as never, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();
  // (lights must be on the phase 2 layer too: the renderer draws what phase 1's occlusion test held back there)
  const hemi = new THREE.HemisphereLight(0xdfeaf5, 0x51493f, 1.4);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 1, far: 600 });
  sun.shadow.camera.layers.set(1); // (the renderer's shadow casters are on layer 1)
  for (const l of [hemi, sun]) l.layers.enable(PHASE2_LAYER), scene.add(l);
  scene.add(sun.target);
  // (in cells: one 12 km quad showed a crack along its diagonal)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000, 96, 96).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: 0x6f7a52, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------------------------------------------------------------- the type: its cluster DAG (in a worker for big meshes)
  const mesh = await loadMesh('./rock.glb');
  const none = new Float32Array(0);
  const dag = await buildDag({ id: 0, bark: { pos: mesh.pos, nrm: mesh.nrm, uv: mesh.uv, idx: mesh.idx }, leaves: { pos: none, nrm: none, uv: none, vpl: 4 } });
  let radius = 0;
  for (let i = 0; i < mesh.pos.length; i += 3) radius = Math.max(radius, Math.hypot(mesh.pos[i], mesh.pos[i + 1] - HEIGHT / 2, mesh.pos[i + 2]));
  const type: NaniteType = { ...dag, name: 'rock', radius, height: HEIGHT, src: { bark: { pos: mesh.pos, nrm: mesh.nrm, uv: mesh.uv, idx: mesh.idx }, leaves: { pos: none, nrm: none, uv: none, vpl: 4 } } };

  // ---------------------------------------------------------------- instances: a = (x, y, z, scale), b = (cos, sin, type, user)
  let seed = 1;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; // (the same field every run)
  const n = SIDE * SIDE, a = new Float32Array(n * 4), b = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = ((i % SIDE) - SIDE / 2 + random()) * SPACING, z = (Math.floor(i / SIDE) - SIDE / 2 + random()) * SPACING;
    const yaw = random() * Math.PI * 2;
    a.set([x, 0, z, 0.5 + random() ** 2 * 3], i * 4);
    b.set([Math.cos(yaw), Math.sin(yaw), 0, 0], i * 4);
  }

  const textures: NaniteTextures = {
    bark: arrayOf(mesh.image, 512),
    leaf: arrayOf(null, 4), // (no cards: an opaque layer)
    barkLayerOf: () => float(0),
    leafLayerOf: () => float(0),
    alphaToCoverage: false,
    leafDither: false, // (no temporal anti-aliasing here to average a dithered alpha: cut-outs)
    softLeafDither: false,
    impostorDither: false,
  };
  const look = defaultLook();
  const nanite = new NaniteRenderer(renderer, [type], { a, b }, textures, look);
  nanite.u.maxDist.value = 5000;
  // the materials that compute their own position (the software rasterizer's and the splats' resolves): fog to the sky
  const fog = (_pos: Vec3, viewZ: Float) => ({ color: vec3(SKY.r, SKY.g, SKY.b), factor: smoothstep(1500, 5000, viewZ) });
  const shading = { fadeShadow: () => Fn(([shadow]: [Float]) => shadow), fog };
  nanite.group.add(nanite.sw.buildResolveMesh(shading));

  // impostors: an atlas from 4 elevations, relit like the geometry; tiny ones splatted in compute
  const atlas = createAtlas(1);
  const impostors = nanite.buildImpostorMesh(atlas, [{ side: [1, 1, 1], top: [1, 1, 1] }]);
  impostors.receiveShadow = true;
  nanite.group.add(impostors, nanite.splats.build(atlas, { ...shading, shadow: () => Fn(([shadow]: [Float]) => shadow) }), nanite.buildImpostorShadowMesh(atlas));
  bakeImpostors(renderer, atlas, [type], { bark: textures.bark, leaf: textures.leaf, barkLayers: [0], leafLayers: [0], leafAlpha: makeLeafAlpha(textures.leaf, attribute('uv', 'vec2')) }, look, nanite.u.impostorPx.value);
  await impostorCoverage(renderer, atlas, IMPOSTOR_CUT);
  nanite.impostorsBaked(atlas, [[1, 1]]);
  nanite.splats.enabled.value = 1;
  scene.add(nanite.group);
  scene.fog = new THREE.Fog(SKY, 1500, 5000); // (the hardware draws' fog; the resolves add theirs)

  // ---------------------------------------------------------------- the frame: cull, phase 1, occlusion, phase 2
  const target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
  target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  nanite.setDepthSource(target.depthTexture, 1); // (the HZB is built from this frame's phase 1 depth)
  const present = new THREE.QuadMesh(new THREE.MeshBasicNodeMaterial({ colorNode: texture(target.texture) }));
  const size = new THREE.Vector2();
  const resize = (): void => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    renderer.getDrawingBufferSize(size);
    target.setSize(size.x, size.y);
  };
  addEventListener('resize', resize);
  resize();

  const t0 = performance.now();
  let lastStats = 0;
  const state = { frames: 0, nanite, camera, controls }; // (for the harness, --example, and a look from the console)
  Object.assign(window, { __example: state });
  renderer.setAnimationLoop(async () => {
    state.frames++;
    const time = (performance.now() - t0) / 1000;
    controls.update();
    camera.updateMatrixWorld();
    look.viewer.copy(camera.position); // (no curvature by default; a curved look drops from here)
    sun.position.set(camera.position.x - 160, 220, camera.position.z - 60); // (behind the camera; the shadow map follows it)
    sun.target.position.set(camera.position.x, 0, camera.position.z);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.camera.updateMatrixWorld();

    nanite.update(camera, size, time, sun.shadow.camera);
    renderer.setRenderTarget(target);
    camera.layers.set(0);
    renderer.render(scene, camera);
    nanite.occlusion(camera, size.x, size.y);
    nanite.rasterize(camera, size.x, size.y);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    sun.shadow.autoUpdate = false;
    camera.layers.set(PHASE2_LAYER);
    renderer.render(scene, camera);
    camera.layers.set(0);
    sun.shadow.autoUpdate = true;
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(null);
    present.render(renderer);

    if (time - lastStats > 0.5) {
      lastStats = time;
      const s = await nanite.readStats();
      info.textContent = `${n.toLocaleString()} rocks (${dag.stats.barkTris.toLocaleString()} triangles, ${dag.stats.barkClusters} clusters, ${dag.stats.barkLevels + 1} levels)\n` +
        `drawn: ${s.instances.toLocaleString()} as clusters, ${s.impostors.toLocaleString()} impostors, ${(s.splats ?? 0).toLocaleString()} splats\n` +
        `${(s.barkTris / 1e6).toFixed(2)}M triangles + ${((s.swTris ?? 0) / 1e6).toFixed(2)}M software, ${s.occluded.toLocaleString()} occluded`;
    }
  });
}

main().catch((e: unknown) => {
  info.textContent = String(e instanceof Error ? e.message : e);
  console.error(e);
});
