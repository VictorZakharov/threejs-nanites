// The WebGPU mode's forest (src/webgpu-start.ts): the trees' texture arrays, the NaniteForest with its software
// rasterizer, the impostors (quads, splats, shadow quads) baked and their coverage, and the grass, each material
// handed to the precompile (src/warmup.ts) as soon as it's final.
import * as THREE from 'three/webgpu';
import { Fn, attribute, float, mix, smoothstep } from 'three/tsl';
import { TERRAIN_SEGMENTS } from './terrain.ts';
import { createGrass } from './grass.ts';
import { VARIANTS, type BuiltTree } from './trees.ts';
import { NaniteForest } from './forest/forest.ts';
import { makeLeafAlpha, LEAF_DITHER } from './nanite-lib/index.ts';
import { bakeImpostors, createAtlas, impostorCoverage, IMPOSTOR_CUT } from './nanite-lib/index.ts';
import { arrayTexture, layerLookup } from './textures.ts';
import { forestDensity, type TreeInstances } from './placement.ts';
import { asReceivedShadow } from './three-gaps.ts';
import type { createLighting } from './lighting.ts';
import type { setupGround } from './ground/setup.ts';
import type { Precompile } from './warmup.ts';
import type { LoadingScreen } from './loading.ts';
import type { DemoState } from './harness-api.ts';
import type { LayerData } from './texture-pixels.ts';
import type { Float, Vec3 } from './types.ts';

export interface ForestSetup {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  ui: LoadingScreen;
  demo: DemoState;
  params: URLSearchParams;
  TREE_COUNT: number;
  terrainSize: number;
  barkTypes: string[];
  leafTypes: string[];
  t0: number;
  plantedMs: () => number;
  barkLayers: Promise<LayerData>[];
  leafLayers: Promise<LayerData>[];
  planting: Promise<TreeInstances>;
  growing: Promise<BuiltTree[]>;
  samples: number;
  terrain: THREE.Group;
  ground: ReturnType<typeof setupGround>;
  lighting: ReturnType<typeof createLighting>;
  shadowsOn: () => boolean;
  pre: Precompile;
}

export async function buildForest(o: ForestSetup) {
  const { renderer, scene, camera, ui, demo, params, TREE_COUNT, terrainSize, barkTypes, leafTypes, t0, plantedMs, barkLayers, leafLayers, planting, growing, samples, terrain, shadowsOn, pre } = o;
  const { cover: density, litter, groundFar } = o.ground;
  const { sun, sunDir, fogNear, fogFar, fogColour, skyCapture, cubeCam, makeFadeShadow, treeFarShadow, farShadowOn } = o.lighting;
  const trees = await growing;
  const buildMs = performance.now() - t0;
  await ui.update(0.77, 'Pressing leaves and bark into texture arrays');

  const [barkTex, leafTex] = await Promise.all([arrayTexture(barkLayers, 1024), arrayTexture(leafLayers, 1024)]);
  barkTex.colorSpace = leafTex.colorSpace = THREE.SRGBColorSpace;
  leafTex.wrapS = leafTex.wrapT = THREE.ClampToEdgeWrapping;

  await ui.update(0.8, `Scattering ${TREE_COUNT.toLocaleString()} trees`);
  let ts = performance.now();
  const lap = (label: string): void => {
    ui.note(`${label} (${Math.round(performance.now() - ts)} ms)`);
    ts = performance.now();
  };
  const instances = await planting;
  lap(`Planted ${(instances.a.length / 4).toLocaleString()} trees, bushes and statues in workers, done ${Math.round(plantedMs())} ms in; waited`);
  const covered = forestDensity(instances, density); // (in a worker, while the forest is built)
  const forest = new NaniteForest(renderer, trees, instances, {
    bark: barkTex,
    leaf: leafTex,
    barkLayerOf: layerLookup(VARIANTS.map((v) => barkTypes.indexOf(v.bark))),
    leafLayerOf: layerLookup(VARIANTS.map((v) => leafTypes.indexOf(v.leaf))),
    alphaToCoverage: samples > 1 && params.get('a2c') !== '0',
    leafDither: samples === 1 && LEAF_DITHER,
  });
  lap('Forest buffers and passes');
  for (const t of trees) t.later?.tree.then((full) => forest.fillType(full)); // (Lucy, whenever she's downloaded)
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
  pre.add(forest.group); // (compiling while the ground and the impostors are made)
  // and the culling's compute passes (a dry run; the instance passes' compile is the slowest after the ground's)
  let passes = pre.addComputes(() => {
    forest.update(camera, new THREE.Vector2(1920, 1080), 0, shadowsOn() ? sun.shadow.camera : null);
    forest.rasterize(camera, 1920, 1080);
    const rt = forest.main.retest; // (the occlusion's retests: as slow to compile, and they don't need its depth yet)
    if (rt?.treesPass && rt.clustersPass) renderer.compute([rt.treesPass, rt.clustersPass]);
    const B = forest.main.sets[1]; // (phase 2's cluster pass)
    renderer.compute([B.clampDispatch, B.clusters, B.clampDraw]);
  });
  // the impostors (quads, splats, shadow quads): built and compiled now, against the atlas before it's baked
  // (createAtlas: the bake and the coverage fill it in place)
  const atlas = createAtlas(VARIANTS.length);
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
  // tiny impostors splatted in compute (src/nanite-lib/gpu/splats.ts), shaded as the impostor material: same shadow and fog
  const splatMesh = forest.splats.build(atlas, {
    shadow: (pos: Vec3) => Fn(([shadow]: [Float]) => makeFadeShadow(treeFarShadow, pos)(shadow.mul(mix(float(1), treeFarShadow, farShadowOn)))),
    fadeShadow: (pos: Vec3) => makeFadeShadow(treeFarShadow, pos),
    fog: (pos: Vec3, viewZ: Float) => ({ color: fogColour(pos), factor: smoothstep(fogNear, fogFar, viewZ) }),
  });
  forest.group.add(splatMesh);
  const impostorShadow = forest.buildImpostorShadowMesh(atlas);
  impostorShadow.visible = impostorMesh.visible;
  forest.group.add(impostorShadow);
  pre.add(impostorMesh, splatMesh, impostorShadow);
  const sp = forest.splats;
  passes += pre.addComputes(() => [sp.args, sp.depthPass, sp.idPass].forEach((p) => p && renderer.compute(p)));
  lap('Software rasterizer');
  litter.plant(instances);
  lap('Litter map');
  // grass around the viewer (src/grass.ts)
  const grass = createGrass({
    terrain: terrain.getObjectByName('terrain') as THREE.Mesh, size: terrainSize, segments: TERRAIN_SEGMENTS,
    cover: density, u: forest.u, receivedShadow: asReceivedShadow(makeFadeShadow(groundFar)), sunDir, renderer,
  });
  demo.grass = grass;
  scene.add(grass.group);
  scene.add(forest.group);
  pre.add(grass.group);
  passes += pre.addComputes(() => grass.update(camera));
  lap('Grass');

  await ui.update(0.82, 'Baking far-field impostors and the sky');
  pre.apart(() => cubeCam.update(renderer, skyCapture));
  const tb = performance.now();
  pre.apart(() => bakeImpostors(renderer, atlas, trees, {
    bark: barkTex,
    leaf: leafTex,
    barkLayers: VARIANTS.map((v) => barkTypes.indexOf(v.bark)),
    leafLayers: VARIANTS.map((v) => leafTypes.indexOf(v.leaf)),
    leafAlpha: makeLeafAlpha(leafTex, attribute('uv', 'vec2')),
  }, forest.look, Number(params.get('bakepx') ?? forest.u.impostorPx.value))); // (the default switch size, before ?imppx=)
  const bakeMs = performance.now() - tb;
  await impostorCoverage(renderer, atlas, IMPOSTOR_CUT);
  // (?impcovside= / ?impcovtop=: a factor per variant instead of VARIANTS' impCov, to calibrate)
  const covParam = (k: 0 | 1, name: string) => params.get(name)?.split(',').map(Number) ?? VARIANTS.map((v) => v.impCov[k]);
  const [covSide, covTop] = [covParam(0, 'impcovside'), covParam(1, 'impcovtop')];
  forest.impostorsBaked(atlas, VARIANTS.map((_, k): [number, number] => [covSide[k], covTop[k]]));
  forest.splats.enabled.value = forest.splats.wanted && impostorMesh.visible ? 1 : 0;
  ui.note(`Impostor atlas: ${atlas.frames.length} tiles; trees under ${forest.u.impostorPx.value}px tall become 2-triangle quads (bake ${Math.round(bakeMs)} ms, read back ${Math.round(atlas.coverage.ms?.readback ?? 0)} ms, coverage ${Math.round(atlas.coverage.ms?.work ?? 0)} ms)`);
  return { forest, grass, instances, buildMs, covered, passes };
}
