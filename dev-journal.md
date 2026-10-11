# Dev journal: where Nanite Forest is going

The current direction, open problems and decisions, so a new session can carry on without redoing work. **Not a
history:** when something is done or no longer matters, cut it down to a line under "Decided" or delete it. Keep it
short. History is in git; how things work is in `AGENTS.md`.

## Goal

A three.js WebGPU tech demo: 1M ez-tree trees and 1.5M bushes, Nanite-style cluster LOD, free flight from the forest
floor to 9 km, on one planet-curved world (R = 150 km). Smooth (5.5 ms GPU budget on desktop: 144 Hz on an RTX 4070
Ti; 14 ms on phones), and it must *look* right: no popping, flicker, brightness seams or missing trees. Feedback
comes from the live site, by screenshot and the performance panel's copied report.

## Next

- **Temporal upscaling.** Below full resolution the browser stretches a smaller canvas (blurry); on high-density
  phone screens the demo renders at most 1.5 pixels per CSS pixel, less under auto quality ("pixelated"). Render
  the scene below the canvas resolution and rebuild full resolution in the TAA resolve (history at output size,
  jitter over the output pixels), then let auto quality lower the resolution before tau gets coarse.
- **Phones high up.** Done: the shadow map gives way to the average shadow, grass and occlusion off up there, and
  auto quality keeps the resolution when lowering it doesn't pay. Left: ~300k impostors on a 288x521 screen. The
  sub-2 px keep share is `w / MIN_PX` while the quad grows `(MIN_PX / w)^2`, so coverage grows as trees shrink;
  `(w / MIN_PX)^2` would draw ~4x fewer from high up but changes the look (calibrate against geometry first).
- **Occlusion bounds.** On `ground` (`--probe=cullcheck --query=ids=1`): 1.07M triangles seen of 3.5M drawn; the
  largest unculled share (1.27M) is clusters whose sphere's rect shows something farther: tighter bounds (cluster
  boxes, normal cones).
- **Zoom over the canopy on High** (`canopyzoom --zoom=5`): ~14 ms at 1080p; leaf overdraw (half the pixels saves
  7 ms). Coarser leaves (`leaferr`) would change the look.
- **Software rasterizer** now pays only in zoomed views (-0.1 ms) and costs ~0.1-0.2 ms elsewhere: the max-error
  bark DAG and the coverage-matched leaf levels left few tiny triangles. Off by default, or only while zoomed?
  Rasterizing the shadow map in software is the other use left.
- **Low-end GPUs** (a laptop iGPU, Macs): auto quality has no knob for some fixed costs (instance passes over
  2.5M, impostor retests, grass). A last tier, or a start preset per GPU class. Mac GPU timestamps can't be trusted
  (more GPU ms than frame ms).
- **Startup:** 4.9 MB bundle (ez-tree's textures), several seconds of shader compile.
- **Visuals:** clouds don't cast shadows, strong haze high up, TAA ghosting behind clouds, a faint step at the
  fog line (impostors vs geometry: `impcov` 0.9), impostor gains to recalibrate with `--query=autumn=0`.
- **Code:** ~60 URL tuning params scattered across modules -> one options object; `main.ts` is over 400 lines.
- **Library shape:** `NaniteForest` is forest-specific (ez-tree input, wind, leaf cards, tints, planet curve,
  impostor gains). Generic pieces: the cluster DAG builder for any mesh, the GPU-driven instanced renderer, the
  impostor baker, the software rasterizer, with forest behaviour as hooks. three.js has `TRAANode` and
  `GodraysNode`: build on them or say why not (our jitter must precede culling; trees need wind motion vectors).
- **Models:** glTF/OBJ input to `tools/nanite-model.ts`; rebuild Lucy with the max-error DAG (hers is sum-built).

## Decided (keep)

- Files stay under ~300-400 lines: `src/nanite/` split by stage, `main.ts` split into modules.
- `src/` and `tools/` are strict TypeScript; Node runs the tools directly (type stripping).
- Trees become 2-triangle impostors under ~20 px tall (each tree its own threshold); impostors are relit (albedo +
  normal atlases), cross-faded by a dither, never narrower than 2 px, and cast shadows. Billboards are what make
  1M trees cheap from the air; occlusion culling is for the forest interior.
- Leaf LOD levels keep the coverage of the leaves they replace (not their area); bark group errors are the max of
  their children's and their own (Nanite's rule).
- Past the shadow map and from high up, receivers use an average shadow (canopy self-shadow, ground darkened by
  forest density), not full sun.
- Planet curvature is applied in the vertex shaders (drop d^2/2R) to everything, culling included.
- The scene renders into a HalfFloat target (one sample under TAA, 4x MSAA without); a render pipeline tone-maps
  it to the canvas.
- Work straight on `main`; every push deploys to Pages; check the deployed site with `--url` after pushing.

## Known issues

- Equal-depth draw-order ties give ~20-100 px of frame-to-frame differences (`--flicker`).
- Two harness runs of the same settings differ by ~1k pixels over 8/255 (TAA history, litter rebuild timing):
  compare images against that floor.
