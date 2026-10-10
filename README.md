# Nanite Forest

A three.js (WebGPU) tech demo: a 1M-tree forest rendered with a Nanite-style, GPU-driven cluster LOD system.
Trees are generated with [ez-tree](https://github.com/dgreenheck/ez-tree).

Needs a WebGPU browser (Chrome / Edge).

## Controls

Click to fly (captures mouse + keyboard in fullscreen, so Ctrl+W doesn't close the tab).

| Key | |
|---|---|
| WASD / mouse | move / look |
| Right mouse (hold) | zoom 5× |
| Space / Ctrl | up / down |
| Shift | fast (speed also builds up the longer you hold a movement key) |
| L | debug colours: clusters / DAG level / trees / tree types |
| F | freeze culling (fly around and inspect what was selected) |
| [ ] | error threshold in pixels (turns auto quality off) |
| Q | auto quality on/off (keeps GPU time under budget) |
| P / T / G / R / H | shadows / anti-aliasing (TAA) / wind / god rays / help |
| Esc | settings menu: quality presets, every switch, Profile GPU |

On a phone or tablet: the left thumb is a movement stick (push further to go faster), the right thumb drags to look,
and buttons on the right hold up / down / 5× zoom; the gear opens the settings (`touch=1` / `touch=0` forces the touch controls on / off).

The panel at the top left shows average FPS and the 1% low over the last 15 s, frame time, GPU time (draw +
culling) and the quality; click or tap it to copy a performance report to paste into an issue. Settings → Profile GPU adds a breakdown
(GPU time with each feature switched off in turn) to that report.

URL params: `trees=1000000`, `planet=150000` (radius, m), `tau=1.5`, `shadows=0`, `smap=2048`, `budget=8` (ms; 14 on touch devices), `auto=0`, `aa=0`, `pr=1`, `debug=1..3`.

## How it works

- **Build (web workers, at startup):** each tree variant's bark mesh is split into 128-triangle clusters
  (meshoptimizer), then repeatedly grouped (~8 adjacent clusters), merged, simplified to half with the vertices shared
  with other groups locked (no cracks between LODs), and re-split, giving a cluster DAG. Leaves are alpha-tested
  cards that can't be edge-collapsed; their groups are reduced by keeping half the leaves and growing them by √2.
- **Per frame (GPU compute, no readback):** instance cull (frustum, distance) emits work items only for the clusters
  that could possibly be selected (clusters sorted by parent error → binary search), then a cluster pass picks the DAG
  cut (`own error ≤ τ < parent error`, projected to pixels), frustum-culls, and appends to draw lists.
- **Software rasterizer (Nanite-style):** clusters whose triangles average under ~4 px² skip the hardware draw:
  a compute pass rasterizes them into a visibility buffer (per pixel: depth, then triangle id, with 32-bit atomics),
  and a fullscreen pass shades each pixel from its triangle with the same three.js lighting, shadows and fog.
  The hardware rasterizer is slow on pixel-sized triangles; this keeps trees as geometry down to 20 px tall.
- **Far field:** trees under ~20 px tall are drawn as camera-facing impostor quads (an atlas baked at startup from
  the full-detail trees), flagged per tree by the instance pass: ~1M trees to the horizon for ~1 ms.
- **Planet:** the world is bent in the vertex shaders (drop = d²/2R, R = 150 km) so the horizon curves; terrain
  continues as a coarse skirt to ~65 km, and fog takes the sky's colour. A cloud deck sits at ~2.2 km.
- **Draw:** two indirect draws (bark, leaves) for the clusters of larger triangles; every draw instance is a cluster and the vertex shader pulls its
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
