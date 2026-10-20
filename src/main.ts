import * as THREE from 'three/webgpu';
import { createTerrain } from './terrain.ts';
import { loadFloorMaps } from './ground/floor.ts';
import { buildAllTrees } from './trees.ts';
import { LoadingScreen } from './loading.ts';
import { loadLayer } from './textures.ts';
import { forestRadius, plantForest } from './placement.ts';
import { startWebGPU } from './webgpu-start.ts';
import type { DemoState } from './harness-api.ts';

declare global {
  interface Window {
    __demo: DemoState; // (what the harness drives, see harness-api.ts)
  }
}

const params = new URLSearchParams(location.search);
const HARNESS = params.has('harness');
const TREE_COUNT = Number(params.get('trees') ?? 1000000);
if (HARNESS) document.body.classList.add('harness');
if (params.get('help') === '1') document.body.classList.add('show-help'); // (the key help under the harness)

// shadowShift: debug offset of the shadow-map centre (harness sweeps)
const demo: DemoState = (window.__demo = { ready: false, error: null, shadowShift: new THREE.Vector3() });
const ui = new LoadingScreen();
demo.loadLog = ui.entries; // (the harness's --load: the boot's timeline)

// ---------------------------------------------------------------- WebGPU first
// Without it (Firefox on Android), nothing starts until the warning's Continue: then a reduced WebGL 2 mode
// (src/webgl/), the same world without the GPU-driven forest (issue #39; it used to grow every tree first, ~2.4 s of a
// phone's work, and then say there's no WebGPU). The adapter is asked for at once, alongside the workers (awaiting it
// first held them back ~0.3 s); a null adapter (a blocklisted GPU) gets the warning when it's known.
// (?nogpu=1: as if the browser had no navigator.gpu; ?webgl=1: the WebGL mode where there is one)
const gpu = params.get('nogpu') === '1' || params.get('webgl') === '1' ? undefined : navigator.gpu;
const adapterReady = gpu?.requestAdapter({ powerPreference: 'high-performance' });

// ---------------------------------------------------------------- setup
// Everything that needs no GPU starts in workers at once, before the GPU is even ready: the bark and leaf texture
// arrays' layers (src/texture-worker.ts), the forest floor's maps (src/ground/), the planting (src/planting.ts), the
// trees grown with their cluster DAGs (src/trees.ts) and Lucy's download.
const barkTypes = ['oak', 'birch', 'pine', 'stone']; // (stone: the models')
const leafTypes = ['oak', 'ash', 'aspen', 'pine'];
// terrain reaches past the ragged forest edge (trees go out to 1.35 x radius) and the fog (its grids: terrain-worker.ts)
const terrainSize = Math.max(9000, Math.ceil(forestRadius(TREE_COUNT) * 2.7 + 3000));
const t0 = performance.now();
let plantedMs = 0;
function beginLoading() {
  const barkLayers = barkTypes.map((t) => loadLayer(t === 'stone' ? 'stone' : `./textures/${t}_color_1k.jpg`, 1024));
  const leafLayers = leafTypes.map((t) => loadLayer(`./textures/${t}_color.png`, 1024, true));
  const floorMaps = loadFloorMaps();
  const planting = plantForest(TREE_COUNT).then((p) => ((plantedMs = performance.now() - t0), p));
  const growing = buildAllTrees(ui, (leaf) => leafLayers[leafTypes.indexOf(leaf)].then((l) => l.mask));
  const terrainReady = createTerrain(terrainSize);
  // (a failure surfaces where it's awaited; meanwhile no unhandled-rejection noise)
  for (const p of [...barkLayers, ...leafLayers, floorMaps.ready, planting, growing, terrainReady]) p.catch(() => {});
  return { barkLayers, leafLayers, floorMaps, planting, growing, terrainReady };
}

type Loading = ReturnType<typeof beginLoading>;

async function start(adapterReady: Promise<GPUAdapter | null>) {
  const loading = beginLoading();
  await ui.update(0.02, 'Waking the GPU');
  const adapter = await adapterReady;
  if (!adapter) return webgl('This browser has WebGPU, but no GPU it can use (blocklisted or turned off).', loading);
  await startWebGPU({ adapter, ui, demo, params, harness: HARNESS, trees: TREE_COUNT, terrainSize, barkTypes, leafTypes, t0, plantedMs: () => plantedMs, ...loading });
}

/** No WebGPU: the warning, then (on Continue) the reduced WebGL mode, with the loading already started if it was. */
async function webgl(reason: string, loading?: Loading): Promise<void> {
  const { WEBGL_HINT, startWebGL } = await import('./webgl/start.ts');
  // (the harness presses Continue itself; with ?gate=1 it stops there: --load then shows what ran before it)
  const asked = ui.ask(reason, WEBGL_HINT, 'Continue in WebGL mode', HARNESS && params.get('gate') !== '1');
  if (HARNESS && params.get('gate') === '1') demo.error = 'stopped at the WebGL warning (?gate=1)';
  await asked;
  await startWebGL({ ui, demo, params, harness: HARNESS, trees: TREE_COUNT, terrainSize, barkTypes, leafTypes, t0, ...(loading ?? beginLoading()) });
}

const fail = (e: unknown): void => {
  console.error(e);
  demo.error = String(e instanceof Error ? (e.stack ?? e) : e);
  ui.fail(e);
};
(adapterReady ? start(adapterReady) : webgl('WebGPU is not available in this browser.')).catch(fail);
