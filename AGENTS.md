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

- **Files stay under ~300-400 lines** (the user's rule): split a module before it grows past that. The forest
  renderer is `src/nanite/`: `forest.js` (the `NaniteForest` class: buffers, per-frame calls, stats) with its
  methods in modules by stage, attached as prototype mixins (`culling.js`, `hzb.js`, `draw.js`, `billboards.js`),
  plus `softraster.js`, `shading.js` (material pieces) and `constants.js`. `src/main.js` is setup and the frame
  loop; `lighting.js` (sky, fog, sun, shadow map), `textures.js`, `placement.js` and `harness-api.js`
  (`window.__demo`) are split out of it.

- `src/trees.js` generates ez-tree variants (main thread: ez-tree loads textures through the DOM), scaled to metres.
- `src/dag-worker.js` builds each variant's cluster DAG in a worker: bark via meshoptimizer (128-tri clusters,
  groups of ~8, simplify to half with group-border vertices locked); leaves by keeping half the cards and growing
  them √2 per level. Every cluster stores its LOD sphere/error and its parent group's sphere/error.
- `src/nanite/` does everything per frame on the GPU, once for the camera and once for the sun's shadow map:
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
- Impostors (`src/impostors.js`): the atlas has four tiles per variant, baked from 0, 30, 60 and 90 degrees up
  (`ELEVATIONS`); the quad faces the camera and cross-fades between them by elevation as the *union* of the
  silhouettes (mixing alphas thins the forest). With only side and top tiles, trees seen from ~45 degrees were the
  top tile's dark splats (the user: "piles of poop"), and from high up the whole screen was one flat top view
  ("flat like google maps"); with the in-between tiles, off-centre trees lean outwards like real ones. A
  cylindrical billboard is edge-on from above and leaves a bald patch under the camera. Each tile's quad is
  enlarged (`GROW`, `?grow=a,b,c,d`) to match the coarse cluster LODs it replaces, the shadow quads too; calibrate
  `?imppx=100000` (all impostors) against `?imppx=0` (all geometry) by mean colour on the `slope` and
  `topdown700` views. Alpha is coverage-preserving per mip (`impostorCoverage` reads the atlas back once).
- Each tree switches to its impostor at its own size (`switchPx` in `src/nanite/shading.js`: impostorPx x a
  per-tree factor in [1/1.6, 1.6], `?impspread=`). With one threshold the switch was a line at a fixed distance
  that slid along with the camera (`--dolly` shows why: small real trees flicker in motion, impostors don't).
- Impostors cast shadows: the shadow view flags the trees it leaves as impostors, and `buildImpostorShadowMesh`
  draws their billboards turned to the sun into the shadow map. So the real map is used wherever it reaches; an
  average shadow where trees were impostors changed visibly at the switch and with the zoom. An impostor looks the
  map up on its sun side (`vShadowPos`: past its own caster quad) times the average self-shadow `?treeshade=`.
- The shadow map's extent grows with altitude (texels ~2 px at the nearest ground) up to `?shadowmax=` (6000 m
  half-extent); the light's depth range grows with it. Capped at 640 m, it was a rectangle of real shadows inside
  an evenly shaded forest seen from 1.8 km.
- Far-field shadow: past the shadow map, receivers fade to an *average* shadow instead of none (`makeFadeShadow` in
  `lighting.js`): a constant canopy self-shadow on trees (`?treeshade=`) and forest-density darkening on the ground
  (`forestDensity`, `?groundshade=`, `?crown=`). Fading to fully sunlit made distant forest brighter, with a line
  where the map ends. Calibrate with `?farall=1` (far shading everywhere) vs the real map on `topdown700`, comparing
  mean image colour.
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
- Software rasterizer (`src/nanite/softraster.js`, main view only): the cluster pass sends clusters whose triangles
  average under `swArea` px² (`?swarea=`, default 4; `?sw=0` = hardware only) to a list that compute passes
  rasterize into a visibility buffer: atomicMin of view depth, then atomicMax of (slot, triangle) + 1 where the
  depth matches (no 64-bit atomics in WebGPU). A fullscreen quad on the phase 2 layer (`buildResolveMesh`) rebuilds
  each pixel's triangle and shades it with a Lambert material whose normal, shadow position and depth are
  overridden; fog is applied in its `outputNode`. Don't give its shared nodes names (`toVar('x')`): three.js
  builds the normal in a separate sub-build that re-declares them, and the pixels came out black. Leaves emulate
  three.js alpha to coverage (`smoothstep(0.5, 0.5 + fwidth(a), a)` against a fixed per-pixel threshold): a plain
  0.5 cut made distant crowns solid. Check with `?debug=5` (software pixels orange) and `--ab="sw=0|sw=1"` (mean
  colours should agree). Not in the HZB (it's built before) and not used for the shadow map yet.
- Temporal anti-aliasing (`src/taa.js`, `?taa=0` / T to turn off): the camera is jittered by a sub-pixel Halton
  offset each frame (`?taajitter=`, default half a pixel: MSAA does the geometric edges) *before* culling, so the
  culling, the software rasterizer and the draws see the same camera; the dither pattern (`ditherShift`) moves every
  frame too. The resolve rebuilds where each pixel was from the depth buffer and last frame's camera (undoing the
  planet curvature's shift with the viewer), minus the trees' own wind motion: the scene target has a second output
  `wind` (MRT), written by the tree materials (`mrtNode`, from `_vertex`'s `prevWorld` at `prevTime`), 0
  elsewhere. The reprojection is one matrix (last frame's view-projection x this frame's inverse) multiplied on the
  CPU in double precision: rebuilding the world position on the GPU in float32 from a depth near 1 fetched the
  history up to half a pixel off with the camera standing still, every frame, and 3 km away through the 5x zoom the
  blur plus the clipping turned crowns into ghosts (the user: "distant trees are washed"; `?taadebug=2` shows the
  offsets, all zero when still; `?taafeedback=1` turns the accumulation off). History: Catmull-Rom lookup (bilinear blurred the swaying leaves), clipped to the 3x3 neighbourhood's
  colour spread (YCoCg), blended 10% per frame in a perceptual space (square root of linear light, `?taaspace=linear`
  for the old blend): averaged in linear light, the far pines' tips (sub-pixel specks against the bright sky) came
  out as pale ghosts (the user: "ghosted peaks"; `peaks` view, ridge colour vs `taa=0&pr=2` at 800x450); the output adds a light unsharp mask
  (`?sharpen=`). Small real trees shimmered in motion and impostors didn't: that's what made the switch band
  visible while moving (`--dolly` on `slope`: 71 flicker events -> 9). Costs ~0.5 ms GPU.
- Far shimmer under TAA: distant trees were hard cut-outs (impostor alpha sharpened by `impostorCoverage`, software
  leaves by the a2c smoothstep), so each few-pixel crown was a blob that hit or missed pixels, and TAA's history
  clipping let that through when turning. With TAA on, impostors and software-rasterized leaves instead draw each
  pixel with the probability of its filtered alpha (= its coverage) against the moving dither, and TAA averages it
  (`?impalpha=dither|cut`, `?leafalpha=dither|a2c`; scales `?impcov=0.9`, `?leafcov=0.9` match the geometry's mean colour;
  `impcov` 0.94 matches exactly but the turning test flickers ~15% more). That alpha test uses `ditherAlt`, a pattern
  independent of the cross-fade's `dither`: an offset copy of the same noise is nearly the same pattern, and in the
  cross-fade band it passed almost all or almost none of a tree's pixels (a darker band at the switch on the fog line).
  Turning test (`--dolly --step=0 --turn=0.2`, numbers drift between setups: compare A/B in one run): fogline ~2050,
  slope ~1125 flicker events with TAA, slope ~3840 without.
- Touch controls (`src/touch.js`, GitHub issue #1): a floating stick under the left thumb, look drag on the right,
  hold buttons for up / down / zoom; they feed `FlyControls.analog` and yaw/pitch. On by `(pointer: coarse)`, or
  `?touch=1|0`; the harness only with `touch=1` (`--probe=touch` fires synthetic finger events and checks each
  control responds).
- The scene target's alpha is not shown: the output pass writes alpha 1. Alpha-to-coverage leaves left alpha < 1
  there, and the canvas showed the light-blue page background through them (the whole forest read paler and bluer).
- Occlusion culling (`src/nanite/culling.js`, `hzb.js`, main view only): two phases per frame. Phase 1 tests trees and clusters
  against *last* frame's HZB (built with last frame's camera, read through the same uniforms before they're
  updated) and draws what passes; `occlusion()` then rebuilds the HZB from this frame's depth (max over each
  pixel's MSAA samples, `sceneRT.depthTexture`) and retests the failures; what's visible is drawn by the phase 2
  meshes (layer `PHASE2_LAYER`, a second `renderer.render` with autoClear and shadow updates off). Impostors are
  drawn there too, tested once against this frame's HZB (they're listed in the retest list with `IMP_BIT`; hidden
  ones get their flag cleared). Clouds are on that layer too, so they're drawn after every tree. Check with the
  `bark` view (one trunk fills the screen): occlusion off draws 67M tris, on ~0.6M. The HZB lookup reads up to 4x4 texels of a finer level than
  usual: at 2x2 the texels near the horizon take in sky and nothing is ever occluded.
