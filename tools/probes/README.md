# Probes

Page-side measurements, run by the harness after each view (`npm run harness -- --probe=<name>[,<name>]`).
Write a measurement here once and reuse it; don't paste one-off probes into `--eval` or `tools/tmp/`. Retyped probe
code drifts from the demo, and a probe that silently measures nothing looks the same as a clean result.

A probe file holds one JavaScript expression, an async function `(demo, view) => result`:

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
| `profile` | the panel's GPU profile in the real loop: median render/compute ms with each feature switched off in turn (`--timeout=240`) |
| `menu` | the settings menu: opens it with Esc, clicks each switch and the quality presets, reads the state back; leaves it open for the screenshot |
| `touch` | touch controls (`--query=touch=1`): synthetic finger events, how far the stick moved, the drag turned, the buttons climbed and zoomed; `stuck` lists what failed |
