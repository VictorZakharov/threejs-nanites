# Dev journal: where Nanite Forest is going

The current direction, open problems and decisions, so a new session can carry on without redoing work. **Not a
history:** when something is done or no longer matters, cut it down to a line under "Decided" or delete it. Keep it
short. History is in git.

## Goal

A three.js WebGPU tech demo: 1M ez-tree trees, Nanite-style cluster LOD, free flight from the forest floor to 9 km,
on one planet-curved world (R = 150 km). Smooth (5.5 ms GPU budget: 144 Hz on the user's 4070 Ti), and it must *look* right: no
popping, flicker, brightness seams or missing trees. The user tests on the live site and reports by screenshot.

## Performance (user, 2026-10-11: "dropped below 144" on the 4070 Ti; Mac at 4 fps "instead of 40+")

- Bisected by commit (`ground`, tau 8, 1632x918, GPU ms): before god rays 3.42, menu 3.54, bushes+grass 5.68,
  floor/relief 6.18, autumn 7.11 (a different forest sample there: one more rnd() per tree), last 6.60. Fixed the
  fixed cost: impostor draws over every instance -> a compact list (6.60 -> 4.08); shadow casters at 5 x tau (half
  the shadow triangles); litter rebuild sliced (the 1% lows); desktop budget 5.5 ms.
- High (tau 1, 1920x1080, the user wants 144 on a 4070 Ti): `plazane` 12.1 -> 10.2 ms frame (leaf LOD
  `LEAF_ERR` 0.35 -> 0.175) -> 8.5 (no MSAA: one sample + alpha to coverage by a moving dither under TAA). The
  "occlusion over-culls without MSAA" was a misread (`msaa=2` is 1 in WebGPU; the image is identical with `occ=0`:
  a 0.5 cut-out just makes crowns solid). Profile there now (GPU 7.9 ms): tree draws 3.6, half the pixels 2.2,
  shadow map 1.6, grass 0.55 (-> 0.2: tiles in view only), sw raster 0.3, TAA 0.26. Tried: bark normal weights
  (fewer triangles, 3x the popping: kept), one-tap shadow filter (`?shadowfilter=basic`, -0.3 ms, hard texel
  edges: kept PCF). The shadow pass is fill: 1024² -0.7 ms, 4096² +3 ms, half the caster triangles -0.26, no leaf alpha
  test -0.1..0.5, nearest-the-sun-first order 0. Leaf vertices: indexed (4 shader runs a card, not 6): -0.3..0.65 ms.
  Leaf fragments (main view, `plazane` / `canopy`): all lighting 0.6 / 1.5 ms, of it the shadow lookup 0.26 / 0.66,
  fog 0.07 / 0.34; a depth prepass didn't pay (the vertex work twice). Compute dispatches batched into ~5 passes a
  frame (were ~36): -0.4..0.8 ms of frame time the GPU timers never showed. `plazane` now ~7.2 ms frame (~138 fps). The software rasterizer only from 25 m up (it lost 0.3-0.4 ms on the
  ground): `plazane` 6.96 ms (~144 fps). Instance passes over the chunks in view only (was 2.5M threads, for the
  camera and the sun): 6.5 ms (~154 fps), `ground` 6.9. Terrain and sky drawn after the trees (early depth
  rejection of hidden floor): `canopy` -0.5, the rest -0.05..0.2. The worst view on High is now `canopy` (10.6 ms,
  45 m over the treetops looking across): leaf overdraw (half the pixels -4.3 ms). A leaf depth prepass helps only
  there (-0.9; +0.24..0.64 on the ground): not taken. Tried, no gain: a 2-tap shadow filter rotated per frame (-0.03..0.1 ms). Next: the shadow map (1.6 ms: 3.4M caster triangles; not every frame? but then frames alternate),
  the per-pixel cost (relief floor, leaf overdraw), frame time ~1 ms over the GPU sum (bubbles between passes?).
- Loading: planting 6.8 s -> in workers during tree growth (done ~1.8 s in, waits 0 ms). Shader compile ~4.7 s is
  now the bulk of "First frame ready".
- Phone (S25, 2026-10-11): 60 fps on the ground, 21 at 9 km (`phonetop`: 898k impostors listed, GPU 43 ms); the
  sure-to-be-dropped sub-2 px ones are no longer listed (1.35M -> 375k at its size). Still: the keep share is
  wPx / MIN_PX while the quad grows (MIN_PX / wPx)^2, so coverage grows as trees shrink (squared would draw ~4x
  fewer from high up, but changes the look: calibrate against geometry first).
- Low-end laptop (AMD RDNA-2 iGPU, 2026-10-11): 15 fps at the spawn, GPU 62 ms at tau 8, 52% resolution, 471k
  triangles: fixed per-pixel/pass costs. Done: the shadow map follows the resolution (1024 there; on the dev GPU at
  its settings 5.97 -> 4.51 ms). Next: ask for its Profile GPU after this; then a last auto tier (grass, relief off).
- NEXT (user, 4070 Ti, 2026-10-11): right-mouse zoom over the canopy into the distance drops frames to 20 ms (p95
  21.8 ms, GPU 9.6 = 6.0 render + 3.6 compute; on High): view `canopyzoom` `--zoom=5` at 1920x1080: 28 ms, 38M
  hardware + 35M software triangles, 33k trees as geometry (20-50 px ones at ~1350 triangles each). Done: bark
  group errors by max, not sum (`--probe=lodcut`: far trees' bark was levels too fine): 31M + 9M, ~24 ms, -0.3..1 ms
  on every view. Rejected: a bigger impostor switch while zoomed (imppx 100: 12 ms, but far pines become fat fuzzy
  cones without trunks); lighter bark normal weights (20x the popping close up). Occlusion removes ~5% there (the
  foliage's holes). Auto quality: zooming out restores the unzoomed setting at once (it sat at tau 8 for seconds);
  zooming in starts sharp (a remembered zoom setting made every zoom "washed", the user: "optimize the algo before
  we downgrade"). Shadow casters culled to those whose shadow can land in view: `zoomdown` (the user's washed zoom,
  looking down from 544 m) 17.9 -> 4.75 ms (38M shadow triangles -> 258k). High (manual tau 1) still costs 22 ms at
  `canopyzoom`: per-triangle ~0.28 ms/M hardware (wind costs
  nothing), fill ~9 ms (the leaf levels keep the card area: half the cards, twice the size). Coarser leaves
  (`leaferr=0.12`: 19.4 ms) would change the look: the user's call.
- NEXT (user, 2026-10-11): "deep inside the forest it renders 3000 trees, I'm seeing at most 50": occlusion culling
  on the ground (the HZB from the foliage's depth has holes). Check what's drawn vs visible, cull what isn't.
- Phone (S25, 2026-10-11, zooming at 2.7 km): 48.8 fps avg but 1% low 6.9, 16 frames over 50 ms (longest 190): hitches
  not reproduced on the dev GPU (phone-size `autozoom` with a tight budget: longest 9 ms). At 9 km "washed": it sits
  at tau 8 and 50% (288x521 on a 1440 px wide screen), GPU 23.7 ms for a 14 ms budget: needs its Profile GPU.
- HUD / panel triangle counts now include the impostors (2 each) and small counts read as numbers (the user: "0 + 0
  tris, obviously a lie" from 4.9 km: all impostors, 1,440 software triangles shown as 0.00 M).
- Waiting: the Mac's Profile GPU report after this (its GPU timestamps aren't trustworthy: 383 ms GPU in a 230 ms
  frame). If it's still far off: auto quality has no knob for the remaining fixed costs (instance passes over 2.5M,
  ~240k impostor retests, the shadow map, grass): a last tier (bushes nearer, shadows off) or a Mac start preset.

## Immediate (user, 2026-10-10): fix these first, then decide on the roadmap below

Done, waiting for the user's check on the live site:
- **5x zoom: distant trees washed out** (user: "the opposite of intended"). A TAA bug, not fog: the reprojection
  rebuilt world positions in float32 from depth and fetched the history up to half a pixel off with a still camera;
  blur + clipping made crowns ghostly (worst far away through the zoom). Now one double-precision CPU matrix.
- **Switch line on the fog line while climbing/descending.** Two causes: the impostor/software-leaf alpha dither was
  correlated with the cross-fade dither (coverage up to 50 points off inside the band; now `ditherAlt`), and
  impostors were 5-8/255 brighter than geometry in the distant rows (`impcov` 0.85 was calibrated with the TAA bug;
  now 0.9: ~1/255 left; 0.94 matches but flickers more when turning).
- **Ghosted peaks** (user screenshot: far pine tips pale against the sky). TAA averaged in linear light: sub-pixel
  dark specks on bright sky read far too pale. Now blended in sqrt space (`peaks` view vs `taa=0&pr=2`: ridge blue
  182 -> 169, reference 160). Tried and dropped: wider/no clipping box (no effect), per-triangle dither rotation
  (overlapping cards then go solid), sharper software-leaf coverage.
- **Fog-line step still visible** (user, after the fixes above). Impostors vs geometry by row on `fogline`: the
  switch rows (~400-480) want `impcov` ~1.05, `slope` wants ~0.9; 1.0 costs ~30% more turning flicker on `slope`.
  Kept 0.9 (switch rows +1-2/255). A view-dependent density difference underneath; need the user's screenshot/spot.
- **Phone perf** (user, Samsung S25: 17 fps, gpu 68 ms at 252 m, auto tau already 8 px). Done: the performance
  panel (copy report), and auto quality lowers the resolution past tau 8 (budget 14 ms on touch). Waiting for the
  user's report from the phone: draw vs compute split decides the next step (fill: MSAA/TAA off on mobile; compute:
  the 1M-instance passes, shadows).
- **Mobile controls** (GitHub issue #1): `src/touch.ts`, checked with `--probe=touch --query=touch=1` headless; not
  yet tried on a real phone (WebGPU on mobile: Chrome Android, Safari 26).

- **TypeScript (user: "javascript is not maintainable")**: done, `src/` strict, `npm run build` type-checks.
- **Mac: no real trees** (user report: "empty plains and semitransparent trees"): shaders bound up to 14 storage
  buffers; now at most 8 (merged buffers). Ask the reporter to confirm.

## Ground (user, 2026-10-10: "make ground fancier... grass and bushes")

- Grass (rings of instanced blades), bushes (ez-tree bush presets as Nanite variants) and last-stand's forest floor
  with parallax relief are in. Waiting for the user's look. The floor under dense canopy reads dark (shade).
- Tree impostor gains have drifted (typematch on `d550`: pines 1.17/1.16/1.47, before the bushes too): recalibrate
  the trees with `--typematch=calibrate` and check the fog line again (with `--query=autumn=0`: the gains are for
  green leaves).
- Autumn (user: "trees of varying color... leaves underneath match, red fall the most"; then "matching the trees
  above them in shape and color", conifers "a thick layer" with a photo): in, per tree through the litter map near
  the viewer. Leaf edges are texel-stepped up close (5 mm texels, binary key); the floor reads dark in shade.

## Models (user: "generalize our nanites for any model... Lucy... to prove it works"; "a cobblestone road through
the forest towards an open area with statues circle")

- In: the model pipeline, Lucy x12 round the plaza at the road's end. Next if wanted: glTF/OBJ input to the tool, a
  model's own textures (now one generated stone), impostor gains for Lucy (1,1,1, not calibrated), the road from
  the air reads as a plain grey band (fine?).

## Roadmap toward open source (user plans to publish it, maybe a three.js contribution; "has to be good")

1. Performance off the dev GPU: tuned only on an RTX 40; forest views 6-11 ms vs the 8 ms budget. Occlusion's
   hidden ~4 ms (see Known issues). HUD ms vs fps mismatch. Quality presets by GPU; test Mac Chrome, Safari, Firefox.
2. Startup: 4.9 MB bundle (ez-tree textures), seconds of shader/compute compile.
3. Visuals: flat clouds without shadows, strong haze high up, TAA ghosting behind clouds, equal-depth flicker,
   screen-edge shimmer when turning.
4. Open-source hygiene: no LICENSE (package.json says ISC from the template; check ez-tree and texture licences),
   README for newcomers (how it works, browser support, screenshots/video), ~26 URL tuning params scattered across
   modules -> one options object, decide whether AGENTS.md / CLAUDE.md / dev-journal.md stay public.
5. Library shape: `NaniteForest` is forest-specific (ez-tree input, wind, leaf cards, tints, planet curve, impostor
   gains). Generic pieces: cluster DAG builder for any mesh, GPU-driven instanced renderer, impostor baker, software
   rasterizer, with forest behaviour as hooks. Core three.js won't take a system this size: standalone library +
   demo, open a discussion before any PR. three.js already has `TRAANode` and `GodraysNode`: build on them or say why
   not (our jitter must precede culling; trees need wind motion vectors).

## Now

- **Occlusion culling (in progress).** Two-phase, Nanite-style, per tree, per cluster and per impostor
  (`src/nanite/culling.ts`, `hzb.ts`). `bark` view (screen = one trunk): 67M -> 0.6M tris, 22 -> 2.4 ms. Little gain in grazing
  views over the canopy (`zoomref`, `--zoom=5`: 55M tris): every row's crown top peeks over the row in front.
  Next: tighter leaf cluster bounds; then decide whether the zoom case needs a coarser tau instead.
- **Software rasterizer + visibility buffer (new, in progress).** Works and matches the hardware look; default views
  are now 6-11 ms (over the 8 ms budget in the forest: auto quality raises tau). A ~23 px tree is ~1500 triangles
  (leaf error 0.35 x card size keeps ~3 px cards). Next: software-raster the shadow map (7-14M hardware tris, depth
  only, one pass); put software pixels in the HZB; one raster pass instead of two; zoomed views (`zoomref`
  `--zoom=5`: 71M sw tris, 24 ms).
- **Billboard -> tree swap too visible** (user, on the live site: "shadows also change", "piles of poop", a line
  that moves with the camera, a rectangle from 1.8 km, "flat like google maps"). Done: swap at 20 px; impostors
  cast shadows; 4 atlas elevations; per-tree switch size (`impspread`); shadow map grows with altitude (no
  rectangle). Colour match all-geometry vs all-impostors: `slope` 53.6 vs 53, `topdown700` 47.5 vs 46.9.
  Small real trees shimmered in motion (impostors don't), which showed the switch band while moving: fixed with
  TAA (`src/taa.ts`; `--dolly --views=slope`: 71 -> 9 flicker events). Check with the user on the live site.
- **Far shimmer (user: "TAA helps near, not far").** Fixed by drawing far impostors and software leaves by
  coverage with a moving dither (TAA averages it): turning flicker now about that of a supersampled render.
- **TAA (new).** Depth reprojection + wind motion vectors for the hardware-drawn trees (not for the software-
  rasterized ones or impostors: small on screen). Watch for: smearing at high flight speed, softness, ghosting
  behind fast-moving clouds (they're reprojected as sky).
- **Startup:** "Compiling shaders" now steps through groups with a status each (`[loading]` lines in the harness
  `console.log`). The compute passes dominate: culling ~0.6 s, occlusion ~0.45 s, software raster ~0.3 s.
- **God rays (new):** screen-space, fed through TAA (`src/godrays.ts`). Next if wanted: clouds blocking them.

## Decided (keep)

- Files stay under ~300-400 lines (user): `src/nanite/` split by stage, `main.ts` split into lighting/textures/
  placement/harness-api. `dag-worker.ts` (~410) is next if it grows.

- Trees become 2-triangle impostors under `impostorPx` (20 px tall; was 40, the swap was too visible) and the DAG
  cut uses tau 1 px (tau 1.5 made the distant treeline pop). Trees between ~20 and ~60 px are mostly drawn by the
  software rasterizer (`src/nanite/softraster.ts`, triangles under 4 px²): at 20 px it's 15-35% less GPU than hardware.
  Impostors are relit (albedo + normal atlases), dither cross-fade with geometry, never narrower than 2 px. Billboards are what make 1M trees cheap from the air;
  occlusion culling is for the forest interior and doesn't replace them.
- Past the shadow map and in the impostor zone, receivers use an average shadow (canopy self-shadow, ground
  darkened by forest density), not full sun: that was the "brightness change of distant trees".
- Planet curvature is applied in the vertex shaders (drop d^2/2R) to everything, culling included.
- Speed ramps up the longer a movement key is held (cap 900 m/s); right mouse = 5x zoom (shadow LOD unaffected).
- The scene renders into a HalfFloat target (one sample under TAA, 4x MSAA without); `RenderPipeline` tone-maps it to the canvas.
- Work straight on `main`, every push deploys to Pages; check the deployed site with `--url` after pushing.

## Known issues

- HUD shows ~23 ms per frame while fps reads 60 (reported by a tester). Probably the `gpu` figure (sum of GPU
  timestamp spans over all passes, which may overlap or include idle gaps) read as frame time, or the HUD's
  ms/fps averaging. Check what each HUD number measures and label them clearly; fold into the perf panel work.
- Occlusion at `orbit`: 5.5 ms vs 4.2 with `occ=0` (was 8 vs 4: each compute dispatch was its own pass, ~36 a frame;
  now ~5, `computeBatch`, -0.4..0.8 ms frame everywhere). What's left there is retesting ~2M impostors (1.1 ms
  compute) to hide 8%: off high up?

- Equal-depth draw-order ties give ~20-100 px of frame-to-frame differences (`--flicker`).
- Bundle is ~4.9 MB (ez-tree's inlined textures).
- Haze is strong at high altitude; clouds are flat sheets without shadows.
