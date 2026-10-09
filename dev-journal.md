# Dev journal: where Nanite Forest is going

The current direction, open problems and decisions, so a new session can carry on without redoing work. **Not a
history:** when something is done or no longer matters, cut it down to a line under "Decided" or delete it. Keep it
short. History is in git.

## Goal

A three.js WebGPU tech demo: 1M ez-tree trees, Nanite-style cluster LOD, free flight from the forest floor to 9 km,
on one planet-curved world (R = 150 km). Smooth (8 ms GPU budget on an RTX 40), and it must *look* right: no
popping, flicker, brightness seams or missing trees. The user tests on the live site and reports by screenshot.

## Now

- **Occlusion culling (in progress).** Two-phase, Nanite-style, per tree, per cluster and per impostor
  (`src/nanite.js`). `bark` view (screen = one trunk): 67M -> 0.6M tris, 22 -> 2.4 ms. Little gain in grazing
  views over the canopy (`zoomref`, `--zoom=5`: 55M tris): every row's crown top peeks over the row in front.
  Next: tighter leaf cluster bounds; then decide whether the zoom case needs a coarser tau instead.
- **Asked for, not started:** god rays (sun through the canopy; the scene now renders into its own target, so a
  screen-space pass fits after it); a performance panel like cape-physics (fps graph, 1% lows, click copies a
  perf report).

## Decided (keep)

- Trees become 2-triangle impostors under `impostorPx` (40 px tall) and the DAG cut uses tau 1 px: at 14 px / tau
  1.5 the distant treeline popped (`--sweep=lod` on `treeline`: 94 jumps -> 2) for about the same GPU time.
  Impostors are relit (albedo + normal atlases), dither cross-fade with geometry, never narrower than 2 px. Billboards are what make 1M trees cheap from the air;
  occlusion culling is for the forest interior and doesn't replace them.
- Past the shadow map and in the impostor zone, receivers use an average shadow (canopy self-shadow, ground
  darkened by forest density), not full sun: that was the "brightness change of distant trees".
- Planet curvature is applied in the vertex shaders (drop d^2/2R) to everything, culling included.
- Speed ramps up the longer a movement key is held (cap 900 m/s); right mouse = 5x zoom (shadow LOD unaffected).
- The scene renders into an MSAA HalfFloat target; `RenderPipeline` tone-maps it to the canvas.
- Work straight on `main`, every push deploys to Pages; check the deployed site with `--url` after pushing.

## Known issues

- HUD shows ~23 ms per frame while fps reads 60 (reported by a tester). Probably the `gpu` figure (sum of GPU
  timestamp spans over all passes, which may overlap or include idle gaps) read as frame time, or the HUD's
  ms/fps averaging. Check what each HUD number measures and label them clearly; fold into the perf panel work.
- Frame time at `orbit` is ~2.4 ms with `occ=0`, ~4.6 ms with occlusion, GPU ~1 ms either way: the occlusion
  frame costs something the timers don't show (13 HZB dispatches + a second render pass; CPU side?).

- Equal-depth draw-order ties give ~20-100 px of frame-to-frame differences (`--flicker`).
- Bundle is ~4.9 MB (ez-tree's inlined textures).
- Haze is strong at high altitude; clouds are flat sheets without shadows.
