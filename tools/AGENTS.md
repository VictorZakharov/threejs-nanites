# tools/AGENTS.md: the harness

How to look at and measure the demo without a screen. `npm run harness -- --help` lists every option; this file
is about using it well.

## Rules

- **Never develop blind.** Every visual or performance change is checked here (screenshots + numbers) before it's
  called done. Look at the screenshots, not only the numbers.
- **Don't retype measurement code.** A measure you need twice goes into the harness: a view in
  `harness/views.mjs`, a page-side probe in `probes/<name>.js`, an image measure in `harness/images.mjs` (+ a
  command in `img.mjs`), an option in `harness/options.mjs`. One-off `--eval` snippets and scripts in `tools/tmp/`
  drift from the demo, and a probe that silently measures nothing reads like a clean result.
- **Temp files stay on G:** (`tools/tmp/`, `tools/out/`, both gitignored); the C: drive is full. The harness points
  the browser's temp folder there itself.
- **Runs are bounded.** A basic run takes ~20 s; the watchdog stops a run that exceeds its expected time
  (`--timeout`, default scaled by views x variants x steps) and names the step it was in. The `secs` column is
  each view's benchmark wall time; boots are timed too. Keep runs small: few views, few variants.
- **One harness at a time.** Two runs share the GPU and both report nonsense timings. GPU timings also swing when
  the user has the demo open: trust numbers that repeat.

## Layout

| file | what |
| --- | --- |
| `harness.mjs` | entry: boots Vite + headless Chromium/Edge with WebGPU, runs the views, writes `tools/out/` |
| `harness/options.mjs` | the command line (and `--help`) |
| `harness/views.mjs` | named viewpoints; add one when a problem needs looking at again |
| `harness/browser.mjs` | temp folder, Vite server, browser launch, page console capture |
| `harness/session.mjs` | booting the demo with a query; per view: benchmark table, probes, screenshot, mean colour |
| `harness/typematch.mjs` | `--typematch[=calibrate]`: impostor vs real-tree colour per tree type (debug=4 masks), calibrates `impGain` |
| `harness/status.mjs` | the current step, for the watchdog |
| `harness/motion.mjs` | `--sweep` (popping when only the LOD/shadow reference moves) and `--dolly` (flicker while moving) |
| `harness/images.mjs` | screenshot measures: mean colour, tree-pixel colour, tile luminance, heatmaps, crops |
| `img.mjs` | command line for those: `node tools/img.mjs mean tools/out/*.png`, `... crop in.png out.png x,y,w,h 4` |
| `probes/` | page-side measures (`--probe=<name>`), see `probes/README.md` |

Output in `tools/out/`: `<view>.png` (A/B: `<view>@<k>.png`), `report.json`, `console.log` (the page console),
heatmaps `sweep-*.png` / `dolly-*.png`, probe images `<probe>-<view>.png`.

## Recipes

```bash
npm run harness -- --views=ground,canopy                       # numbers + screenshots
npm run harness -- --views=zoomref --zoom=5 --probe=occlusion  # zoomed view, occlusion counters
npm run harness -- --views=bark --probe=occlusion --query=wind=0  # one trunk fills the screen: ~nothing else drawn
npm run harness -- --ab="imppx=0|imppx=100000" --views=topdown700 --query="farall=1&wind=0"
                                                               # all geometry vs all impostors: colour match
npm run harness -- --sweep=lod --views=treeline --steps=40 --step=2 --query=wind=0   # LOD popping
npm run harness -- --dolly --views=treeline --steps=30 --step=0.05 --query=wind=0     # flicker while moving
npm run harness -- --ab="sw=0|sw=1" --views=canopy,d550 --query="wind=0&shadows=0"   # software vs hardware raster
npm run harness -- --views=canopy --flicker --query="wind=0&taa=0"   # still camera: differing pixels between frames
npm run harness -- --dolly --ab="taa=0|taa=1" --views=slope --steps=20 --step=0.5 --query=wind=0   # TAA in motion
npm run harness -- --url=https://victorzakharov.github.io/threejs-nanites/ --views=ground,orbit   # after a deploy
```

- Compare like with like: `--ab` reloads the page per variant in one run, so views, size and GPU state match.
  `--sweep`/`--dolly` run per variant too (heatmaps tagged `@<k>`).
- A view can carry its own `zoom` (`bark` uses 5x: the near plane is 0.3 m, so the camera can't get close enough to
  a trunk to fill the screen without it); `--zoom` overrides it.
- Popping and flicker tests need `wind=0` (the harness freezes the clouds itself). With TAA on, every frame is
  jittered, so `--flicker` (identical still frames) needs `taa=0`; `--dolly` measures TAA as seen in motion.
  `?taadebug=1` shows the trees' wind motion vectors. `--turn=0.2 --step=0` turns the camera instead of moving
  it (mouse look: the far field sweeps across the screen); `--rect=x,y,w,h` counts only part of the screen. The
  metric isn't zero for a perfect image (content slides across tiles). `--rise=M` climbs instead (the switch band
  sliding with the altitude). Supersampled references (`pr=2`) must stay under the list caps (1M clusters per list:
  check the `clusters` column, and the software list too): use `--size=800x450 --ab="pr=1|pr=2"` rather than
  `pr=2` at full size, where clusters get dropped and the forest thins.
- Is it a regression? Build the last good commit in a worktree under `tools/tmp/` (`git worktree add`, then
  `npx vite build` there: it resolves the main checkout's node_modules), serve it with `npx vite preview --port N`
  and run the same harness command with `--url=http://localhost:N/`. Compare like with like in one sitting.
- TAA vs a supersampled reference: `--size=800x450 --views=peaks --ab="taa=0&pr=2|taa=1"`, then
  `img.mjs mean ... --rect=` on the far ridge. Don't judge TAA from a single frame (`taafeedback=1`): the output's
  unsharp mask turns isolated dark specks black there (`sharpen=0`).
- `?taadebug=2` shows where each pixel's history is fetched from (x0.1 px, red x, green y): black with a still camera.
- `swTris` counts the triangles the software rasterizer took (`tris` is the hardware ones); `cull` includes its
  compute passes. `--flicker` prints how many pixels differ between still frames (hardware: ~100-900 px of
  equal-depth ties; software ones are stable).
- The table's `gpu` is the render passes' GPU time, `cull` the compute passes', `frame` the pipelined frame time
  (headless, so vsync doesn't cap it). Don't time frames by awaiting `onSubmittedWorkDone` after each one: that
  adds ~4 ms of latency per frame.
- Debug URL parameters worth knowing (see `src/main.ts`, `src/lighting.ts`, `src/nanite/`): `imppx` (impostor size threshold, 0 = no impostors),
  `occ=0` (no occlusion culling), `farall=1` (far-field shading everywhere, to calibrate it), `tau`, `shadows=0`,
  `debug=1|2|3` (cluster / DAG level / tree colours), `wind=0`, `trees=N`.
