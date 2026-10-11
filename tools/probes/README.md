# Probes

Page-side measurements, run by the harness after each view (`npm run harness -- --probe=<name>[,<name>]`).
Write a measurement here once and reuse it; don't paste one-off probes into `--eval` or `tools/tmp/`. Retyped probe
code drifts from the demo, and a probe that silently measures nothing looks the same as a clean result.

A probe file holds one TypeScript expression, an async function `(demo: Demo, view) => result` (`import type { Demo }
from '../../src/harness-api.ts'` above it; the harness strips the types before the page evaluates it):

- `demo` is `window.__demo` (renderer, scene, camera, forest, controls, `renderOnce()`, `setView()`, `stats()`...)
- `view` is the harness view it runs after (already set and benchmarked)
- the result is printed and stored in `report.json` under the view's `probes`; a `png` field holding a data URL is
  saved as `tools/out/<probe>-<view>.png` instead

| probe | what it returns |
| --- | --- |
| `occlusion` | occlusion culling counters: trees and clusters failing phase 1, trees hidden after phase 2, draws per phase |
| `hzb` | the depth pyramid: levels, and a sparse sample of level 0 and 5 (to see that it holds the scene) |
| `atlas` | the impostor atlas (albedo) as a PNG, cut-out alpha shown blue |
| `perf` | the performance panel (`--query=perf=1`): its report text and whether it's on screen |
| `auto` | auto quality in the real loop for 8 s against `?autobudget=` (default 3 ms): settled tau, resolution scale, GPU ms (use `--timeout=120`) |
| `autozoom` | auto quality across the 5x zoom: 4 s each unzoomed / zoomed / unzoomed / zoomed at the view (`canopyzoom --zoom=1`), per phase how long it was over the budget, frames over twice it, the longest frame, resolution changes, tau/scale every 250 ms (`--timeout=120`) |
| `visible` | trees, clusters and triangles drawn vs seen (`--query=ids=1`: debug 6 writes each pixel's tree and cluster to the scene target; hardware geometry only): what occlusion culling leaves on the table |
| `cullcheck` | why drawn-but-unseen clusters weren't culled (`--query=ids=1`): an exact-rect test on the CPU against HZB level 0 sorts them into "a finer test would get it", "only without the wind margin", "something farther shows in its rect"; triangles of each |
| `fulldetail` | what the view would cost without Nanite: the plants in the view frustum (within the view distance) and their full-detail triangles, counted on the CPU (README's with/without table: time a small forest, `trees=2000&tau=0.01&imppx=0&occ=0&sw=0&shadows=0`, and scale by this count) |
| `profile` | the panel's GPU profile in the real loop: median render/compute ms with each feature switched off in turn (`--timeout=240`) |
| `menu` | the settings menu: opens it with Esc, clicks each switch and the quality presets, reads the state back; leaves it open for the screenshot |
| `autumn` | autumn levels: share of green / yellow / red trees, the nearest stand of each (spots of the `autumn*` views) and the cover map's fallen leaves there |
| `litter` | the litter map round the camera (src/ground/litter-map.ts): kind of leaf, amount and autumn level at the camera and 3 m around it, share of each kind |
| `walk` | walking (`--query=walk=1`): stands at eye height, walks, jumps, double-jumps into flight, flies down and lands walking |
| `lodcut` | the DAG cut per tree type by its height on screen (10..400 px, at the page's tau), on the CPU: bark and leaf triangles and clusters, the deepest level, and each level's median error |
| `touch` | touch controls (`--query=touch=1`): synthetic finger events, how far the stick moved, the drag turned, the buttons climbed and zoomed; `stuck` lists what failed |
