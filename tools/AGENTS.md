# tools/AGENTS.md: the harness

How to look at and measure the demo without a screen. `npm run harness -- --help` lists every option; this file
is about using it well.

## Rules

- **Never develop blind.** Every visual or performance change is checked here (screenshots + numbers) before it's
  called done. Look at the screenshots, not only the numbers.
- **Don't retype measurement code.** A measure you need twice goes into the harness: a view in
  `harness/views.ts`, a page-side probe in `probes/<name>.ts`, an image measure in `harness/images.ts` (+ a
  command in `img.ts`), an option in `harness/options.ts`. One-off `--eval` snippets and scripts in `tools/tmp/`
  drift from the demo, and a probe that silently measures nothing reads like a clean result.
- **Temp files stay on G:** (`tools/tmp/`, `tools/out/`, both gitignored); the C: drive is full. The harness points
  the browser's temp folder there itself.
- **Runs are bounded.** A basic run takes ~20 s; the watchdog stops a run that exceeds its expected time
  (`--timeout`, default scaled by views x variants x steps) and names the step it was in. The `secs` column is
  each view's benchmark wall time; boots are timed too. Keep runs small: few views, few variants.
- **Slow boots?** Vite doesn't watch `tools/tmp` or `tools/out` (`vite.config.ts`): profiles left by hung runs there
  (some undeletable, ~100k files) held up the dev server's first requests for minutes (`page.goto` timeouts).
- **One harness at a time.** Two runs share the GPU and both report nonsense timings. GPU timings also swing when
  the user has the demo open: trust numbers that repeat.

## Layout

| file | what |
| --- | --- |
| `harness.ts` | entry: boots Vite + headless Chromium/Edge with WebGPU, runs the views, writes `tools/out/` |
| `harness/options.ts` | the command line (and `--help`) |
| `harness/views.ts` | named viewpoints; add one when a problem needs looking at again |
| `harness/browser.ts` | temp folder, Vite server, browser launch, page console capture |
| `harness/session.ts` | booting the demo with a query; per view: benchmark table, probes, screenshot, mean colour |
| `harness/typematch.ts` | `--typematch[=calibrate]`: impostor vs real-tree colour per tree type (debug=4 masks), calibrates `impGain` |
| `harness/status.ts` | the current step, for the watchdog |
| `harness/motion.ts` | `--sweep` (popping when only the LOD/shadow reference moves) and `--dolly` (flicker while moving) |
| `harness/load.ts` | `--load=N`: cold boots, the loading log's timeline (median), the downloads, `--profile` of the main thread |
| `harness/images.ts` | screenshot measures: mean colour, tree-pixel colour, tile luminance, heatmaps, crops |
| `img.ts` | command line for those: `node tools/img.ts mean tools/out/*.png`, `... crop in.png out.png x,y,w,h 4`, `... diff a.png b.png [where.png]` (pixels that differ: an A/B that should match) |
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
npm run harness -- --sweep=lod --views=treeline --steps=40 --step=2 --query="wind=0&taa=0"   # LOD popping (TAA off: one frame a step, its noise swamps the pops)
npm run harness -- --dolly --views=treeline --steps=30 --step=0.05 --query=wind=0     # flicker while moving
npm run harness -- --ab="sw=0|sw=1" --views=canopy,d550 --query="wind=0&shadows=0"   # software vs hardware raster
npm run harness -- --views=canopy --flicker --query="wind=0&taa=0"   # still camera: differing pixels between frames
npm run harness -- --dolly --ab="taa=0|taa=1" --views=slope --steps=20 --step=0.5 --query=wind=0   # TAA in motion
npm run harness -- --url=https://victorzakharov.github.io/threejs-nanites/ --views=ground,orbit   # after a deploy
npx vite build && npm run harness -- --dist --load=3                    # loading: the production build, as Pages serves it
npm run harness -- --dist --load=3 --size=384x832 --dpr=3 --query=touch=1 --cpu=4   # loading at a phone's size and pace
npm run harness -- --dist=tools/tmp/dist-prof --load=1 --profile        # where the main thread's time goes (see below)
```

- Loading (`--load=N`, `harness/load.ts`): N cold boots, each in a fresh browser (no HTTP or shader cache), print
  the loading log (`[loading]` lines: `LoadingScreen.entries`, ms since the navigation started) as a timeline, the
  median per step, and every download with its gzipped size and when it was done (the workers' fetches included).
  Measure the production build: `--dist` serves `dist/` gzipped as GitHub Pages does (`--dist=<folder>` another
  build: a baseline built in a worktree under `tools/tmp/`), or `--url` the live site or a PR preview. The headless
  browser reads every size uncompressed (Resource Timing and CDP, even from Pages) and its network throttling went
  by those, so there's no network throttle: the sizes are fetched again with gzip, and download time is for the real
  site. `--cpu=4` slows the page's main thread (DevTools' emulation; not the workers, not the GPU process): a phone's
  pace, roughly. Boots swing by ~0.5 s on the desktop and more at `--cpu=4` (the workers compete for the cores):
  compare medians of 3. `--profile` saves the main thread's CPU profile of the first boot
  (`tools/out/load.cpuprofile`, opens in DevTools) and prints the top functions by self time: build without
  minifying for names (`npx vite build --minify false --outDir tools/tmp/dist-prof`).

- Compare like with like: `--ab` reloads the page per variant in one run, so views, size and GPU state match.
  `--sweep`/`--dolly` run per variant too (heatmaps tagged `@<k>`).
- A view can carry its own `zoom` (`bark` uses 5x: the near plane is 0.3 m, so the camera can't get close enough to
  a trunk to fill the screen without it); `--zoom` overrides it.
- Popping and flicker tests need `wind=0` (the harness freezes the clouds itself). With TAA on, every frame is
  jittered, so `--flicker` (identical still frames) and `--sweep` (one frame a step: the same setting gave 678 and
  1310 jumps in two runs) need `taa=0`; `--dolly` measures TAA as seen in motion. The measures leave out the HUD's
  corner (`HUD` in `harness/images.ts`, top right): masked in the top left, where it once was, its changing
  numbers were most of every sweep's jumps and its edge the "worst".
  `?taadebug=1` shows the trees' wind motion vectors. `--turn=0.2 --step=0` turns the camera instead of moving
  it (mouse look: the far field sweeps across the screen); `--rect=x,y,w,h` counts only part of the screen. The
  metric isn't zero for a perfect image (content slides across tiles). `--rise=M` climbs instead (the switch band
  sliding with the altitude). Supersampled references (`pr=2`) must stay under the list caps (1M clusters per list:
  check the `clusters` column, and the software list too): use `--size=800x450 --ab="pr=1|pr=2"` rather than
  `pr=2` at full size, where clusters get dropped and the forest thins.
- Is it a regression? Build the last good commit in a worktree under `tools/tmp/` (`git worktree add`, then
  `npx vite build` there: it resolves the main checkout's node_modules), serve it with `npx vite preview --port N`
  and run the same harness command with `--url=http://localhost:N/`. Compare like with like in one sitting.
- A phone's screen: `--size=384x832 --dpr=3 --query=touch=1` (screenshots at 1152x2496; the demo renders 576x1248
  and upscales). Compare the upscaling with `--ab="taau=0|taau=1"` (the old stretched canvas) and against rendering
  natively at that density (`pr=3`); judge crops, not pixel counts (dithered foliage differs every run).
- TAA vs a supersampled reference: `--size=800x450 --views=peaks --ab="taa=0&pr=2|taa=1"`, then
  `img.ts mean ... --rect=` on the far ridge. Don't judge TAA from a single frame (`taafeedback=1`): the output's
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
