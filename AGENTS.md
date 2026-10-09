# AGENTS.md

Guide for coding agents working on **Nanite Forest**, a three.js WebGPU tech demo: a 1M-tree forest (ez-tree) drawn
with a Nanite-style GPU-driven cluster LOD system. `README.md` is the overview and controls; this file covers the
things that aren't obvious from the code.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run build      # production build into dist/ (relative base: works under the Pages subpath)
npm run harness    # headless benchmark + screenshots, see below
```

## Workflow

- **For now, commit directly to `main`** (no PRs, no branches). A push to `main` deploys production to GitHub Pages
  (`deploy-pages.yml`): https://victorzakharov.github.io/threejs-nanites/ . The repo is private.
- The PR-preview workflows (`pr-preview-build.yml`, `pr-preview.yml`, copied from the sibling projects) are in place
  but unused until PRs are used. Pages is served from the aggregated `gh-pages` branch (production at the root,
  previews under `pr-preview/`); don't delete that branch or switch Pages away from the workflow setup.
- **Ship something viewable early**, then keep iterating: the user wants to look at it and give feedback.
- **Never develop blind:** check every visual or performance change with the harness (screenshots + numbers) before
  calling it done.

## Temp files: never on C:

The C: drive has no free space. Keep every temp/scratch file, probe script, browser profile and test output inside
the project on G: (`tools/tmp/`, `tools/out/`, both gitignored), never in the system temp folder, `/tmp` or a
scratchpad on C:. The harness already points TEMP/TMP at `tools/tmp/browser` before launching the browser.

## Harness (`tools/harness.mjs`)

Boots Vite and a **headless** Chromium (falls back to Edge/Chrome) on the real GPU with WebGPU; nothing pops up on
screen. It flies the camera to fixed views (`ground`, `closeup`, `canopy`, `overview`, `horizon`), reports per view
the pipelined frame time, GPU render time and GPU cull time (timestamp queries), CPU time, visible clusters /
triangles / trees and shadow triangles, and writes screenshots + `report.json` + the page console to `tools/out/`.

```bash
npm run harness -- --views=ground,canopy --frames=120 --query="tau=2&shadows=0"
npm run harness -- --eval="__demo.autoTest(5000, 8)"      # runs the real loop with auto quality, flying forward
npm run harness -- --eval-file=tools/tmp/probe.js           # any page-side probe (window.__demo exposes the scene)
```

`--sweep=lod,shadowlod,shadow` holds the view still and moves only the LOD reference point (or the shadow-caster
LOD reference, or the shadow-map centre), then reports and heat-maps tiles whose brightness jumps from one step to
the next: the way to measure LOD popping. Run sweeps with `--query=wind=0` (the harness also freezes the clouds).

Don't time frames by awaiting `onSubmittedWorkDone` after each one: that adds ~4 ms of latency per frame and made
an empty scene look like 5 ms. Use the timestamp numbers or the pipelined frame time the harness reports.

## Architecture notes

- `src/trees.js` generates ez-tree variants (main thread: ez-tree loads textures through the DOM), scaled to metres.
- `src/dag-worker.js` builds each variant's cluster DAG in a worker: bark via meshoptimizer (128-tri clusters,
  groups of ~8, simplify to half with group-border vertices locked); leaves by keeping half the cards and growing
  them √2 per level. Every cluster stores its LOD sphere/error and its parent group's sphere/error.
- `src/nanite.js` does everything per frame on the GPU, once for the camera and once for the sun's shadow map:
  instance pass → work items for the clusters that can be selected (clusters sorted by parent error, binary search
  gives the prefix) → indirect cluster pass (DAG cut + frustum) → indirect draws with vertex pulling. Shadow-caster
  meshes are on layer 1, which only the shadow camera renders.
- Auto quality (`main.js`) steers the pixel error `tau` so GPU time stays under a budget (default 8 ms).
- Leaf alpha is coverage-preserving: `coverageScales()` finds, per mip level and texture layer, the alpha scale that
  keeps the full-size image's fraction of texels above the 0.5 cut-off; the leaf shader applies it by the sampled
  mip. Without it, a tree's density and brightness jump when its LOD swaps to fewer, bigger cards.
- Bark simplification weights normals/UVs (`simplifyWithAttributes`). meshopt folds attribute error into the error
  it returns, which drives LOD selection: heavier weights mean less texture popping but many more triangles
  (UVs run to ~10 along a branch).
- Leaf PNGs have white RGB under transparent texels; `arrayTexture(..., fillTransparent)` replaces it with the average
  leaf colour, otherwise mipmaps bleed pale halos into the foliage. The aspen texture is autumn-yellow and the pine
  one reads yellow in sun: both get per-layer tints in the leaf material.
- Impostors (`src/impostors.js`): the atlas has a side tile and a top-down tile per variant; the quad faces the camera
  and cross-fades side → top by elevation as the *union* of both silhouettes (mixing alphas thins the forest). A
  cylindrical billboard is edge-on from above and leaves a bald patch under the camera. The top view is enlarged
  (`TOP_GROW`, `?topgrow=`) to match the coarse cluster LODs it replaces; compare with `?imppx=100000` (all
  impostors) vs `?imppx=0` (all geometry) on the `topdown700` harness view. Alpha is coverage-preserving per mip
  (`impostorCoverage` reads the atlas back once).
- Far-field shadow: past the shadow map, receivers fade to an *average* shadow instead of none (`makeFadeShadow` in
  `main.js`): a constant canopy self-shadow on trees (`?treeshade=`), forest-density darkening on the ground
  (`forestDensity`, `?groundshade=`, `?crown=`), and impostors scaled by `?impshade=`. Fading to fully sunlit made
  distant forest brighter, with a line where the map ends. Calibrate with `?farall=1` (far shading everywhere) vs
  the real map on `topdown700`, comparing mean image colour.
- Right-mouse zoom (5x) narrows `camera.fov`; LOD follows via projScale (full detail, as if 5x closer), while the
  shadow view's tau is multiplied by the zoom (shadow-map resolution doesn't change; without it shadow casters went
  to 63M tris). Zoomed into deep forest it's still ~55k trees x ~1000 tris: no occlusion culling yet.
