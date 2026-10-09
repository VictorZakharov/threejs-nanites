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
npm run harness -- --ab="imppx=0|imppx=100000" --views=topdown700 --query="farall=1&wind=0"
                                                               # all geometry vs all impostors: colour match
npm run harness -- --sweep=lod --views=treeline --steps=40 --step=2 --query=wind=0   # LOD popping
npm run harness -- --dolly --views=treeline --steps=30 --step=0.05 --query=wind=0     # flicker while moving
npm run harness -- --url=https://victorzakharov.github.io/threejs-nanites/ --views=ground,orbit   # after a deploy
```

- Compare like with like: `--ab` reloads the page per variant in one run, so views, size and GPU state match.
- Popping and flicker tests need `wind=0` (the harness freezes the clouds itself).
- The table's `gpu` is the render passes' GPU time, `cull` the compute passes', `frame` the pipelined frame time
  (headless, so vsync doesn't cap it). Don't time frames by awaiting `onSubmittedWorkDone` after each one: that
  adds ~4 ms of latency per frame.
- Debug URL parameters worth knowing (see `src/main.js`): `imppx` (impostor size threshold, 0 = no impostors),
  `occ=0` (no occlusion culling), `farall=1` (far-field shading everywhere, to calibrate it), `tau`, `shadows=0`,
  `debug=1|2|3` (cluster / DAG level / tree colours), `wind=0`, `trees=N`.
