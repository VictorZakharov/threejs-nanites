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
  calling it done (see `tools/AGENTS.md`).

## Temp files: never on C:

The C: drive has no free space. Keep every temp/scratch file, probe script, browser profile and test output inside
the project on G: (`tools/tmp/`, `tools/out/`, both gitignored), never in the system temp folder, `/tmp` or a
scratchpad on C:. The harness already points TEMP/TMP at `tools/tmp/browser` before launching the browser.

## Harness

`tools/AGENTS.md` is the harness guide (`npm run harness -- --help` for the options). Measurements you need more
than once go into the harness (views, probes in `tools/probes/`, image tools), never retyped as one-off snippets:
retyped probe code drifts and compounds errors.

## Dev journal

`dev-journal.md` holds the current direction: what's being worked on, what's decided, the known issues. Read it
first in a new session. Update it as you go, and keep it short and current, not historical: trim what's done.

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
- Impostors are *relit*, not baked lit: the bake writes an albedo atlas and a tree-local normal atlas (leaves cut
  out with Discard and alpha 1 so MSAA gives true coverage), and the impostor material is Lambert with the same
  lights, fog and shadow fade as the real leaves. Render-target textures are stored flipped (v = 1 - y).
  Colour is matched per tree type and view (side / top) by `impGain` in `VARIANTS` (`src/trees.js`), calibrated
  with `npm run harness -- --typematch=calibrate --views=d550,fogline --query=wind=0` (masks each type with
  `debug=4`, compares real trees with impostors, adjusts the gains live, prints new values). One gain for all
  types left pines as near-black stars from above. The tiles are baked from the DAG cut each tree has at the
  switch size (`dagCut`, `?bakepx=`, 0 = full detail).
- Geometry and impostor cross-fade with a screen-space dither between 1x and `FADE_HI` x the impostor pixel size.
  Impostors are never drawn narrower than `MIN_PX` (2 px): smaller trees are enlarged and a matching share dropped
  per tree, otherwise sub-pixel trees flicker on/off as the camera moves.
- Software rasterizer (`src/softraster.js`, main view only): the cluster pass sends clusters whose triangles
  average under `swArea` px² (`?swarea=`, default 4; `?sw=0` = hardware only) to a list that compute passes
  rasterize into a visibility buffer: atomicMin of view depth, then atomicMax of (slot, triangle) + 1 where the
  depth matches (no 64-bit atomics in WebGPU). A fullscreen quad on the phase 2 layer (`buildResolveMesh`) rebuilds
  each pixel's triangle and shades it with a Lambert material whose normal, shadow position and depth are
  overridden; fog is applied in its `outputNode`. Don't give its shared nodes names (`toVar('x')`): three.js
  builds the normal in a separate sub-build that re-declares them, and the pixels came out black. Leaves emulate
  three.js alpha to coverage (`smoothstep(0.5, 0.5 + fwidth(a), a)` against a fixed per-pixel threshold): a plain
  0.5 cut made distant crowns solid. Check with `?debug=5` (software pixels orange) and `--ab="sw=0|sw=1"` (mean
  colours should agree). Not in the HZB (it's built before) and not used for the shadow map yet.
- The scene target's alpha is not shown: the output pass writes alpha 1. Alpha-to-coverage leaves left alpha < 1
  there, and the canvas showed the light-blue page background through them (the whole forest read paler and bluer).
- Occlusion culling (`src/nanite.js`, main view only): two phases per frame. Phase 1 tests trees and clusters
  against *last* frame's HZB (built with last frame's camera, read through the same uniforms before they're
  updated) and draws what passes; `occlusion()` then rebuilds the HZB from this frame's depth (max over each
  pixel's MSAA samples, `sceneRT.depthTexture`) and retests the failures; what's visible is drawn by the phase 2
  meshes (layer `PHASE2_LAYER`, a second `renderer.render` with autoClear and shadow updates off). Impostors are
  drawn there too, tested once against this frame's HZB (they're listed in the retest list with `IMP_BIT`; hidden
  ones get their flag cleared). Clouds are on that layer too, so they're drawn after every tree. Check with the
  `bark` view (one trunk fills the screen): occlusion off draws 67M tris, on ~0.6M. The HZB lookup reads up to 4x4 texels of a finer level than
  usual: at 2x2 the texels near the horizon take in sky and nothing is ever occluded.
