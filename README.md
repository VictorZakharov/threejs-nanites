# Nanite Forest

A three.js (WebGPU) tech demo: a 1M-tree forest rendered with a Nanite-style, GPU-driven cluster LOD system.
Trees are generated with [ez-tree](https://github.com/dgreenheck/ez-tree).

Needs a WebGPU browser (Chrome / Edge).

## Controls

Click to fly (captures mouse + keyboard in fullscreen, so Ctrl+W doesn't close the tab).

| Key | |
|---|---|
| WASD / mouse | move / look |
| Space / Ctrl | up / down |
| Shift | fast |
| L | debug colours: clusters / DAG level / trees |
| F | freeze culling (fly around and inspect what was selected) |
| [ ] | error threshold in pixels (turns auto quality off) |
| Q | auto quality on/off (keeps GPU time under budget) |
| P / G / H | shadows / wind / help |

URL params: `trees=1000000`, `tau=1.5`, `shadows=0`, `smap=2048`, `budget=8` (ms), `auto=0`, `aa=0`, `pr=1`, `debug=1..3`.

## How it works

- **Build (web workers, at startup):** each tree variant's bark mesh is split into 128-triangle clusters
  (meshoptimizer), then repeatedly grouped (~8 adjacent clusters), merged, simplified to half with the vertices shared
  with other groups locked (no cracks between LODs), and re-split, giving a cluster DAG. Leaves are alpha-tested
  cards that can't be edge-collapsed; their groups are reduced by keeping half the leaves and growing them by √2.
- **Per frame (GPU compute, no readback):** instance cull (frustum, distance) emits work items only for the clusters
  that could possibly be selected (clusters sorted by parent error → binary search), then a cluster pass picks the DAG
  cut (`own error ≤ τ < parent error`, projected to pixels), frustum-culls, and appends to draw lists.
- **Draw:** two indirect draws (bark, leaves); every draw instance is a cluster and the vertex shader pulls its
  triangles from storage buffers. The sun's shadow map gets its own cull pass (light frustum, coarser LOD).

## Develop

```sh
npm install
npm run dev
```

### Headless harness

`npm run harness` boots Vite and a headless Chromium on the real GPU, flies to fixed viewpoints, measures GPU time
(timestamp queries), frame time and triangle counts, and writes screenshots + `report.json` to `tools/out`.

```sh
npm run harness -- --views=ground,canopy --frames=120 --query="tau=2&shadows=0"
npm run harness -- --eval="__demo.autoTest(5000, 8)"
```
