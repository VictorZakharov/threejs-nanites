# AGENTS.md

Guide for coding agents working on **Nanite Forest**, a three.js WebGPU tech demo: a 1M-tree forest (ez-tree) drawn
with a Nanite-style GPU-driven cluster LOD system. `README.md` is the overview and controls; this file covers the
things that aren't obvious from the code.

## Commands

```bash
npm install
npm run dev        # Vite dev server
npm run build      # type-check (tsc, strict) + production build into dist/ (relative base: works under the Pages subpath)
npm run typecheck  # tsc only
npm run harness    # headless benchmark + screenshots, see below
```

## Workflow

- **Pull requests with live previews** (the user's, since 2026-10-12): work on a branch, open a PR to `main`. Each
  push to a PR builds a preview at https://victorzakharov.github.io/threejs-nanites/pr-preview/pr-N/ (a sticky
  comment on the PR links it; check it with the harness's `--url`). The user looks at the preview; merge when they
  say so.
- **`main` has only merge commits:** PRs are merged with `gh pr merge N --merge` (squash and rebase merges are
  off; a ruleset blocks direct pushes, force pushes and deletion of `main`). A merge deploys production
  (`deploy-pages.yml`): https://victorzakharov.github.io/threejs-nanites/ ; check it with `--url` afterwards.
- **PR branches have linear history:** only rebases. Start a branch from `origin/main`'s tip (its latest merge
  commit is fine) and bring it up to date with `git fetch` and `git rebase origin/main`, then
  `git push --force-with-lease`; never merge `main` into it. The `Linear history` check
  (`.github/workflows/linear-history.yml`, required by the `main` ruleset) fails a PR with merge commits that aren't on
  `main` already. GitHub's own "require linear history" rule on PR branches refused every new branch cut from
  `main`'s tip (it counts `main`'s merges too), so it was dropped for the check (2026-10-19).
- The repo is public (MIT; since 2026-10-11): pull requests from forks get previews too. Pages is served from the
  aggregated `gh-pages` branch (production at the root, previews under `pr-preview/`); don't delete that branch or
  switch Pages away from the workflow setup.
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

## Goal

1M ez-tree trees and 1.5M bushes with Nanite-style cluster LOD, free flight from the forest floor to 9 km over one
planet-curved world (R = 150 km). Smooth (GPU budget 5.5 ms on desktop: 144 Hz on an RTX 4070 Ti; 14 ms on phones),
and it must *look* right: no popping, flicker, brightness seams or missing trees. Feedback comes from the live site,
by screenshot and the performance panel's copied report.

## Open work: GitHub issues

Open problems and planned work are GitHub issues (`gh issue list`), labelled by priority (`P1` next up, `P2`, `P3`),
area (`performance`, `mobile`, `visuals`, `tooling`, `refactor`, `bug`) and size (`size: S` up to ~2 h, `M` ~3-4 h,
`L` about a day, `XL` more), with the estimate in the body, at this project's pace (the demo took ~3 days from an
empty folder). Read the open `P1`s first in a new session. Close an issue from the commit that fixes it (`Fixes #n`)
and add what you learn to it; open one for a new problem you can't fix now. How things work belongs in this file,
history in git.

## Decided

- Trees become 2-triangle impostors under ~20 px tall (each tree its own threshold); impostors are relit (albedo +
  normal atlases), cross-faded by a dither, never narrower than 2 px, and cast shadows. Billboards make 1M trees cheap
  from the air; occlusion culling is for the forest interior.
- Leaf LOD levels keep the coverage of the leaves they replace (not their area); bark group errors are the max of
  their children's and their own (Nanite's rule).
- Past the shadow map and from high up, receivers get an average shadow (canopy self-shadow, ground darkened by
  forest density), not full sun.
- Planet curvature is applied in the vertex shaders (drop d^2/2R) to everything, culling included.
- The scene renders into a HalfFloat target (one sample under TAA, 4x MSAA without); a render pipeline tone-maps it
  to the canvas.

## TypeScript

`src/` is TypeScript, `strict`, checked by `npm run build` (a type error fails the deploy). TSL nodes are typed by
their shader type: helpers take `Float`, `Vec3`, `Uint`... from `src/types.ts` (`Node<'vec3'>` has the operators, a
bare `Node` has none). Where `@types/three` lags the runtime (Lambert's `emissiveNode`, `receivedShadowNode`'s
argument, the WebGPU backend's `device`, untyped bitcasts), the cast lives in `src/three-gaps.ts` with a note; don't
scatter `as any`. The typings' `min`/`max` take floats only: use `minU`/`minI`/`maxI` (`src/nanite/constants.ts`)
for integers. `uniformArray` needs its type explicitly (`uniformArray<'vec4'>(values, 'vec4')`). Objects with
shader closures are built as typed locals and returned whole (see `_buildSet`, `_buildView`). The stage modules of
`NaniteForest` declare `this: NaniteForest`; the class merges their types through an interface. The tools (`tools/`: harness, probes, model importer) are strict
TypeScript too, checked by `tsc -p tools` (part of `typecheck` and `build`); Node runs them directly (type stripping:
only erasable syntax, `.ts` in imports). A probe is one expression typed against `Demo` (`src/harness-api.ts`, what
`window.__demo` holds); `session.ts` strips its types before the page evaluates it.

## Architecture notes

- **Files stay under ~300-400 lines** (the user's rule): split a module before it grows past that. The forest
  renderer is `src/nanite/`: `forest.ts` (the `NaniteForest` class: buffers, per-frame calls, stats) with its
  methods in modules by stage, attached as prototype mixins (`buffers.ts`, `culling.ts`, `hzb.ts`, `draw.ts`, `billboards.ts`),
  plus `softraster.ts`, `splats.ts` (tiny impostors into its buffer), `shading.ts` (material pieces) and `constants.ts`. `src/main.ts` is setup and the frame
  loop; `lighting.ts` (sky, fog, sun, shadow map), `resolution.ts`, `auto-quality.ts`, `textures.ts`, `placement.ts`, `warmup.ts` (the
  startup's shader compiles) and `harness-api.ts` (`window.__demo`) are split out of it.

- `src/trees.ts` lists the variants; `tree-grow.ts` grows one with ez-tree, scaled to metres, in its DAG worker (see
  Loading below for how ez-tree is bundled).
- `src/dag-build.ts` builds each variant's cluster DAG (in a worker, `dag-worker.ts`; in Node for tools): bark via
  meshoptimizer (128-tri clusters, groups of ~8, simplify to half with group-border vertices locked); leaves
  (`dag-leaves.ts`) by keeping half the cards and growing them until they cover what the group did
  (`dag-coverage.ts`: the cards through their texture's alpha mask, `maskOf` in `texture-pixels.ts`, counted on a grid
  from 4 directions; ~1.3 per level); shared pieces in `dag-util.ts`. Growing by √2 (keeping the area) covered far
  more than the tree (its leaves overlap, the fewer bigger cards much less): each coarser level closed the gaps, and
  at tau 8 the forest was a bright even carpet (the user's zoom: "washed"). Now tau 1..8 look alike (`zoommid`:
  mean colour within 2/255) and match the full-detail leaves (`leaferr=100&shadowtau=1000`); -0.2..1.4 ms on every
  view; the far-field shading matches the real map within 1/255 (was 5). `?leafcover=0` for the old growth. Full
  detail casts less shadow than it should: its leaves are smaller than a shadow texel. Every
  cluster stores its LOD sphere/error and its parent group's sphere/error. A coarser leaf level's error is `LEAF_ERR`
  (0.175, `?leaferr=`) x its leaf size: a *smaller* share switches to it sooner. At 0.35 leaves were kept under ~3 px
  at tau 1 (crowns many deep: ~8 triangles per pixel on High, 7.7M software-rasterized at the user's spot); at
  0.175 a third of that, ~10% less crown coverage past ~200 m (`tree share` on `fogline`/`slope`/`d550`).
- Planting (`src/planting.ts`, plain TypeScript, in `plant-worker.ts` workers, started at the top of loading): the land
  in 512 m tiles, each planted from its own seed with a fixed candidate density (`densityFor` samples the acceptance
  share once so the totals land near 1M trees / 1.5M bushes), assembled in tile order: the same forest whichever
  worker finishes first. It was one main-thread loop over ~7M candidates: 6.8 s of the user's load (half of it
  `roadDistance` looping over the road's segments for every candidate: it has a bounding-box early-out now). Its
  pure dependencies are split out for the workers: `noise.ts` (fbm, `heightAt`), `road-path.ts`, `autumn-cpu.ts`.
- Loading (issue #6; measure with `--load`, `tools/AGENTS.md`): 17.4 -> 6.4 s to the first frame on the dev machine
  (production build, medians of 3 cold boots), 43 -> 20 s at a phone's size and pace (`--cpu=4`); the script 3.3 ->
  0.34 MB gzipped. Everything that needs no GPU starts in workers at the top of `main.ts`, before the GPU is asked
  for: the texture arrays' layers (`texture-worker.ts`: fetch, decode, draw at 1024 on an OffscreenCanvas, the
  leaves' coverage scales and DAG masks; the stone marble), the floor's maps (`floor-worker.ts`, one worker for the
  soil and one per kind of leaf: one for all took ~5 s), the planting, the terrain's grids (`terrain-worker.ts`,
  three's own PlaneGeometry and normals: the same vertices), the trees (each grown and its DAG built in its own
  `dag-worker.ts`, its leaf mask in a second message) and Lucy (`model-worker.ts`). ez-tree's npm build inlined its
  20 textures (4 MB of a 5 MB script) and loaded them through the DOM: Vite bundles its source instead, its textures
  module stubbed (`vite.config.ts`, for the workers too; `optimizeDeps.exclude` so the dev server does the same), and
  ez-tree's bare `three` is three's core from source (only what it uses, in the DAG worker). Shaders: three.js
  compiles a pipeline the first time it draws, and the GPU process compiled them one after another (~10 s of the
  17); `Precompile` (`warmup.ts`) calls `compileAsync` per mesh as soon as its material is final (sky and clouds
  first, the forest after its buffers, the ground after the floor, the impostors after the bake) and
  `compileComputeAsync` for the compute passes (collected by a dry run of the frame's culling, dispatching off), so
  they compile side by side while the main thread goes on. Compiles in flight read the renderer's render target and
  MRT as they build their shaders: the renderer stays on a 1x1 copy of the scene target (the same formats: the same
  pipelines; the scene's own is resized meanwhile, which lost a compile's depth format) and other GPU work (the bake,
  the sky capture) runs synchronously in `apart()`. `warmUp` then draws everything once (the shadow-map versions)
  and runs a frame (the full-screen passes); `?precompile=0` for the old group-by-group compile. Also: the bake's
  materials take their layer and tint as uniforms (4 pipelines, not ~36), the atlas coverage runs in a worker with
  quickselect (sorting each level was 0.6 s in a browser), the road's distance map writes only near each piece of
  paving (0.7 s -> 40 ms, the same values). The loading log (on screen, `[loading]` in the console) times each step
  from the navigation's start; the slowest compiles and the last to finish are named. Then (#33, #32) 5.7 -> 4.1 s,
  19.3 -> 16.8 s at a phone's pace: the ground's materials get their final shaders as soon as the terrain exists
  (`ground/setup.ts`), compiled against their textures before they're filled (floor maps, cover map, litter map: made
  empty at their size, filled in place: the same pipeline), from 1.7 s rather than 3.1; the compute passes compile
  from the forest's creation (dry runs of the culling, the software rasterizer, the occlusion's retests, the grass);
  the cover map is computed in a worker (`cover-worker.ts`); the chunks' runs use typed arrays; the statues no longer
  hold the load up (Models above). three.js builds each shader in steps that yield to the main thread
  (`buildAsync`), so every long main-thread task delays the compiles too: at a phone's pace they "took" 9-15 s.
  The impostors' shaders (quads, splats, shadow quads) compile from the forest's creation too, against an empty
  atlas (`createAtlas`: its render targets, and the frame sizes and coverage scales as uniform arrays the bake and
  `impostorCoverage` fill in place; the splats are switched on once it's filled): the splat pass compiled after the
  bake was the last wait (phone pace -0.6..1.4 s back to back with main; desktop within the noise). What's left is
  the GPU process's compile throughput: some 20 render pipelines and 45 compute passes, the floor's ~1.5 s alone on
  the dev machine (relief and cobbles ~0.6 of it; the rest is the PBR material with shadows), and the atlas read-back
  queues behind them. Starting the terrain's compile before its grids (a stand-in geometry) finished no earlier.
  `--probe=nodebuild` times each material's compile and the main thread's share (small: it's the GPU process).
- Models (any mesh as a variant: `model:` in `VARIANTS`, `isModel`): `tools/nanite-model.ts` (`npm run model`)
  reads a PLY, stands it up (longest axis, or `--up=`), grid-merges huge scans to ~4x the target then meshopt-
  simplifies to `--tris`, quantizes to 16 bits, builds the cluster DAG at `--height` (the variant's metres: errors
  are in metres; another height is scaled, inexactly) and meshopt-compresses both (`public/models/*.nm`, format 2),
  then decodes the file as the site does and checks it matches. `src/models.ts` only decodes (in `model-worker.ts`; no DAG build at load:
  one file for every device; phones had a 20k-tri copy because of the 3 s build, the user asked why two). The DAG's
  vertices are the model's own, so `model-source.ts` rebuilds normals (summed in doubles: order-independent) and
  planar uvs. The index codec may rotate a triangle's corners. It's "bark" with no
  leaves: stone layer in the bark array (`stone.ts`, a generated marble), no wind (`windOf`), not in the canopy cover
  or the litter. Lucy (Stanford, non-commercial with credit; "don't animate or morph" her: hence no wind): 28M ->
  1M tris, DAG 15.7k clusters: 6.45 MB (positions 1.9, DAG triangles 4.1, clusters 0.5). Statues stand on the lowest
  ground under the plinth (`PLINTH`; by the centre one edge floated on the plaza's slope, the user). Models are never
  impostors (`firstModel` in `switchPx`: the statues are last in the instances): theirs came out as pale blobs from
  above, some missing (the user); views `plazatop`, `plazahigh`. Their atlas tiles stay empty (the bake skips them).
  Nothing waits for a model's download (Lucy is ~5 MB): `model-worker.ts` posts the file's header as soon as it has
  arrived, the forest reserves the model's share of its buffers by it with no clusters (`BuiltTree.later`), and
  `fillType` (`src/nanite/buffers.ts`) writes it in when it's decoded, uploads those ranges and refits the boxes of
  the chunks holding the statues (her LOD spheres reach 8.4 m, her mesh's box 2.4). On a slow connection the statues
  appear after the first frame; `?modeldelay=ms` delays her to test that.
  Once, 4 harness runs in a row came out ~2x slower in every pass (compute too) and then didn't reproduce with the
  same code: re-run before bisecting a regression (and compare with the live site via `--url`).
- The road (`src/road.ts`): a cobblestone road from the spawn point ~80 m to a plaza (radius 24 m) with a ring of
  12 statues facing its middle (the user's idea). Placement keeps trees/bushes off it; a half-float distance map
  (25 cm texels; 32-bit float filtering is optional in WebGPU) feeds the grass (none on it) and the floor
  (`ground/cobbles.ts`: Voronoi stones in TSL, domed normals, average colour where finer than the pixels).
  `?plaza=0` drops the ring. Views `plaza`, `plazaair`, `roadair`, `statue`. A waypoint to the plaza's middle
  (`src/waypoint.ts`, the user's): an HTML overlay projected each frame, clamped to the screen's edge with an arrow
  when off screen (`spawnback` view), faded on arrival; a menu switch; hidden under the harness unless `?waypoint=1`.
  The compass strip on top (`src/compass.ts`) shows headings and the same waypoint, only while walking (the user);
  `--query="waypoint=1&walk=1"`. The cobbles fade to their average by the pixel footprint's *area* (by its longest
  side, along the road at a grazing angle, they went flat grey ~10 m ahead: "washed up", the user), in patches.
- `src/nanite/` does everything per frame on the GPU, once for the camera and once for the sun's shadow map:
  instance pass → work items for the clusters that can be selected (clusters sorted by parent error, binary search
  gives the prefix) → indirect cluster pass (DAG cut + frustum) → indirect draws with vertex pulling. The leaf draws
  are indexed with one shared index buffer (`LEAF_INDEX` in `draw.ts`): `dag-build.ts` packs each leaf cluster's
  vertices contiguously as quads, so the GPU shades the two corners a card's triangles share once (4 vertex shader
  runs a card instead of 6: `plazane` 8.33 -> 7.84 ms, `closeup` -0.65, same image). Their indirect args are 5 uints.
  A leaf depth prepass (shade only the front leaf) was tried: 0.8 ms slower on the ground, 0.7 faster over the canopy.
  Each stage's compute dispatches run in one compute pass (`computeBatch` in `three-gaps.ts`: a node's own size or
  indirect buffer): one `renderer.compute()` per dispatch was ~36 passes a frame, most a few threads, and their
  overhead was frame time the GPU timers don't show (-0.4..0.8 ms; `orbit` with occlusion 8 -> 5.5 ms).
  The instance passes run over the chunks in view only (`chunks.ts`): the instances in runs of up to 2048 (a planting
  tile's plants, which the workers put in Morton order) with boxes round their spheres, tested on the CPU per frame and
  view (frustum, fog distance, curvature) and listed two a vec4 in a uniform array (the main view's instance pass
  already binds 8 storage buffers; ~1.1k chunks). It was a thread per instance, 2.5M, twice: the shadow map covers a
  few hundred metres (-0.4 ms compute on the ground, -0.2..0.4 from above; `?chunks=0` tests every chunk: same image). Shadow-caster
  meshes are on layer 1, which only the shadow camera renders.
- Auto quality (`src/auto-quality.ts`) steers the pixel error `tau` so GPU time stays under a budget (default 5.5 ms: 144 Hz on the
  user's 4070 Ti, where 8 sat at ~115 fps; 14 on touch devices); past tau 8 it lowers the resolution (down to half the pixel ratio): phones (user's Samsung S25: 68 ms GPU
  at tau 8) pay mostly for what tau doesn't touch. `--probe=auto` runs it with a 3 ms budget on the dev GPU. Coming back up it restores the resolution first (under 85% of
  the budget), then the detail; `?autostart=low` starts the probe at the bottom ("under 60%" left it stuck blurry
  after the orbit). At full detail (tau 1) under 55% of the budget it raises the resolution past the base pixel ratio
  (1.5) in x1.15 steps, up to the output's (`maxScale` in `resolution.ts`: the screen's, at most 3; 1 on a 1x screen
  or with upscaling off), and over the budget that extra goes first, before tau: a dense screen at 1.5 of its 3 was the
  scene's pixels upscaled 2x (issue #3). A step is x1.32 the pixels, so under 55% it lands under 1.1 and doesn't swing
  back. `--probe=auto --dpr=2 --query=autobudget=20`: scale 1.33 (3200x1800, native); at the phone's size on the dev
  GPU 2 (1152x2496). Far from the budget (over 1.5x or under 0.5x) it steps bigger and every 250 ms. Zooming in starts
  from the unzoomed setting and zooming out restores it at once (it stayed at the zoom's tau 8 for seconds); nothing
  is measured while the zoom eases (`?autozoom=0`; `--probe=autozoom --views=canopyzoom --zoom=1`). Jumping to the
  last zoom's own setting was tried: learned at a costly spot it made every later zoom blurry (the user: "washed",
  "optimize the algo before we downgrade"). A resolution step down is a trial: if it saved under a third of its share of the pixels
  (median raw samples before / after), it goes back and the resolution holds until the cost changes by half (after
  10 s) or for a minute: a phone 8 km up sat at 50%, blurry, for nothing (half the pixels saved 9%: impostors and
  shadows; the user: "with blur, makes it look lame"); `--probe=auto` lists the `trials`. It's off
  under the harness; `?auto=1&touch=1` runs a phone's startup (it starts at 60% resolution) — check it after touching
  `main.ts`'s setup order: a phone-only startup crash shipped once.
- Performance panel (`src/perf-panel.ts`, wired in `src/hud.ts`, after cape-physics): FPS avg / 1% low over 15 s,
  frame p95, GPU draw + compute; a click copies a text report (the user's way to send numbers from other devices).
  Off under the harness unless `?perf=1` (`--probe=perf` prints the report). Bigger type on desktop; its lines never
  wrap, and the HUD on the right only ever widens (`minWidth`): numbers changing width shifted the layout (the user).
  The settings menu's Profile GPU (`src/profile.ts`, `--probe=profile`) holds the view and quality, switches one feature off at a
  time (shadow map, TAA, god rays, clouds, occlusion, software raster, impostor splats, terrain+sky, tree draws, half the pixels) and
  appends the median GPU ms of each to the report: a device's breakdown in one paste. MSAA can't be switched live
  (`?msaa=4`). Its progress shows in a banner (`src/profile-banner.ts`: step, bar, time left, then Copy report; the
  panel's last line alone went unseen on a phone), and the menu button starts it on the press's end, however long (a
  long press fires no click on a phone, and "hold still" read as press and hold: the user). `upscaling off` measures
  the upscaling; no timings for 10 s fails it. `--probe=profileui` runs it as a person does.
- Settings menu (`src/menu.ts`, Esc / the gear on touch screens; layout after gd-clone's pause menu): quality presets,
  the scene switches, debug colours, overlays, Profile GPU, Fullscreen. It also owns the keyboard shortcuts (they flip
  the same switches): add a new switch there once and it gets both. Fullscreen as in last-stand (gd-clone, the user: "there it
  all works perfectly"): F11 is the browser's, the menu's button toggles the page's (and says which), a click only
  captures the mouse, Esc releases it (losing the pointer lock opens the menu) and leaves fullscreen. It used to go
  fullscreen on every capture, take F11 over and Keyboard-Lock Esc: leaving fullscreen took two presses (Resume went
  straight back in), and screenshots of the fullscreen window sometimes failed. Headless can't test the fullscreen
  path: check it by hand. The help pane (`#help` in `index.html`) is one key per action, in a grid (keys sharing a
  fixed-width cell ran into their text: the user). `--probe=menu` clicks every switch and reads it back, and checks that in a short window only the columns
  scroll (title and buttons stay in the box; on touch screens the page's touchmove block lets one finger through
  there).
- Music (`src/music.ts`, the user's: "ez tree had background music"): ez-tree's demo ambience (`public/audio/`), an
  `<audio>` loop fetched on first play; it starts on the first click, tap or key (browsers need a gesture) with a
  fade; M / the menu's switch / the touch screen's ♪ mute it, remembered in localStorage; paused while the tab is
  hidden. It's birdsong: it fades out with the height above the ground (`HEARD`: full to 40 m, silent and paused
  from 300 m; the user: "can't hear if too high"). Off under the harness unless `?music=1` (the harness's browser allows autoplay: `--probe=music`).
- Grass (`src/grass.ts`, `?grass=` ring scale, 0.5 on touch, 0 = off; a menu switch): four rings of
  blades round the viewer (cells 0.09 / 0.18 / 0.36 / 0.72 m out to 16 / 40 / 90 / 200 m, before `?grassdense=`), each a grid of world cells snapped to
  the camera, so blades don't swim. Rings cross-fade by 3D distance and blades widen with the cell, so the covered
  fraction stays even. Blades stand on the terrain mesh's own vertex heights (a float texture, same triangle split as
  PlaneGeometry), density from canopy cover, slope and patch noise; wind writes TAA motion like the trees. Which blades
  are drawn is decided in compute (`src/grass-keep.ts`): a thread per cell of the ring's tiles in view runs the keep
  test (density, tufts, the cross-fade and morph, behind the camera) and appends the kept blades to the ring's list
  (2 uvec4s: root, then height / width / lean / bend / flutter / sun-through in halves and the colour in unorm8s); the
  ring is one indirect draw (`setIndirect`, its instance count from the pass's atomic counter, clamped to the list's
  size, `ringCapacity`). It was all in the vertex shader, every cell's blade drawn, the dropped ones collapsed onto
  their root: the vertex invocations cost, kept or not (`--probe=grass`: ~100-120k kept of ~660k tested on `meadow`).
  Double-sided Lambert needs `normalViewGeometry` (the default flips the normal on back faces: dark blades).
  Each ring morphs towards the next across its width (fewer, wider blades): a plain hand-over was a line in the grass
  that moved with the camera (the user). The rings share their blades: each ring's cells are twice the last's, a
  ring's cell takes the blade of one of its four finer cells (`childOf`, down to a first-ring cell whose hash makes
  the blade), and the thinning keeps exactly those, so over the hand-over band each blade is drawn by one ring or the
  other (its own chance `swap`), the same blade. With blades of their own (cells 0.2 / 0.45 / 1) the bands were where
  one set sank and another rose: a line seen only in motion (the user, 4 m up: `meadowlow`, `--sweep=detail` 18 -> 1
  jumps; the image's mean colour within 1/255; ~1.6-1.9x the blades in the outer rings, +0.04 ms compute, up to
  ~+0.3 render from 25 m up). Each ring's grid is 8 x 8 tiles (`?grasstiles=`) and `update()` lists only
  the tiles in the view frustum and the ring's annulus for the keep pass (a uniform array of their first cells); a
  tile is out of the ring by its 3D distance (by the ground distance alone, from high up every tile under the camera
  was drawn, every blade dropped: 20% of a phone's GPU time 8 km up). Blades: 4 segments, normals rounded across the width, colour per pixel
  (root to tip, midrib, edges, dry tip): `grassclose` view. Blades that come and go with the distance grow out of
  the ground over a share `?grassgrow=` (0.6) of their keep chance: popping in whole, walking showed grass appearing
  ahead (the user); at 0.3 they rose within a metre or two of walking, a band moving along ahead ("a redraw circle",
  seen only in motion). `--sweep=detail` holds the camera and moves only `detailPos` (`src/planet.ts`), where the
  grass, the litter's blend and the relief measure their fades from: what changes is a fade sliding along (use
  `taa=0` and a short sweep, `--steps=6 --step=0.3`: the heatmap is the largest jump over all steps; `meadow` 53 ->
  13 jumps, worst 6.7 -> 4.1/255; growing over the whole chance, 1, made the grass sparser everywhere).
  Tufts: a jittered 0.8 m grid of clump centres in world space (every ring agrees); a tuft's blades share a height
  and dryness, are pulled towards its centre and fan out from it, and where grass is sparse whole tufts are kept or
  dropped (`?grassclump=sparse,dense` gathering, 0,0 = evenly): evenly spread, the forest floor's few blades were lone
  green spikes. Tufts fade out by ~35 m (a ring's cells get as big as them). Blades bend along an arc (capped at ~80
  degrees: further, they lay flat as pale streaks), turn up to ~25 degrees towards the viewer when edge-on, and get
  a yellow-green glow where the sun is behind the face we see (scaled down by canopy cover: the shadow map only
  darkens the surface light, so a glow would stay in the shade). The old root colour (dark green up to 3/4 of the
  blade) made every blade darker than the ground; with the ground's own colour (a debug test) blades matched it, so
  the lighting was fine. Views `meadow`, `meadowclose` (a clearing ~350 m from the spawn).
  Density (the user's reference: a UE meadow, a carpet of thin blades): `?grassdense=` blades per m² x (the cells
  shrink by its root), 6 on desktops, 1 on touch. The blades widen with the cell, so they get thinner too. Cost on the
  dev GPU (render over `grass=0`, 1080p, `meadow`/`meadowclose`/`grassclose`/`ground`): drawing every cell, x1 +0.2-0.3
  ms, x4 +0.5-0.75, x6 +0.8-1.1, as much on the forest floor where nearly every blade is dropped (a branch skipping
  the shaping for dropped blades saved nothing); with the keep pass x4 and x6 are ~+0.05 render and +0.03-0.06
  compute. Blades have 4 / 3 / 2 segments by ring (`segs`: the far ones are a few pixels tall; -0.15 ms). Tufts gather only where grass is sparse (`flat`, before the slope): pulled
  together, a dense meadow was tufts with bare ground between. Each blade has its own green, blue-green to
  yellow-green. The floor's meadow colour is darkened up to half under the blades (`underGrass`, by the same road /
  cover / patch terms, off with the menu's switch): lit as open ground it showed pale olive between them. The
  outermost ring (1 segment: a triangle) fades it back to 1 from the third ring's radius to 80% of its own, and over
  the same span its blades turn to the ground's own colour (`meadowColourAt`), unshaded, as they thin out: with the
  grass ending at 90 m, the darker carpet with pale tips stopped at a line across the meadow (the user; `meadowair`:
  the grass is ~18% darker near, the same as `grass=0` at ~200 m). The fourth ring costs ~+0.05 ms.
- Bushes: ez-tree's Bush 1-3 presets are variants like the trees (cluster DAG, impostors, shadows, occlusion);
  `placeBushes` adds `?bushes=` per tree (1.5, 0.5 on touch) after the trees in the same instance buffers, thickest
  along the clearings' and the forest's edges; the canopy cover map counts trees only (`isBush`). They took the instances from
  1M to 2.5M, which mattered while the impostor draw covered every instance (see the impostor list below). Nine variants overflow one atlas row (9216 px > WebGPU's guaranteed
  8192): `atlasLayout` wraps the tiles into rows (bake, coverage readback and billboard UVs share it). Debug type
  colours (debug 4) are ten hues 36 degrees apart, drawn without fog, tone mapping, ground, grass or god rays
  (`type-masks.ts`: each of those moved or faked hues: ACES turned pines into aspens, sunlit ground passed for Oak Medium);
  typematch takes the hue in linear light and classifies within 18. Gains are linear: a measured sRGB ratio r
  needs about r^2.
- Forest floor (`src/ground/`, after last-stand): `floor-maps.ts` is last-stand's procedural floor without its leaves
  (soil, twigs, pebbles; 5 m tile; heights everywhere in cm / `HEIGHT_CM`); `floor-leaves.ts` the fallen leaves, a
  texture-array layer per kind (oak lobed, ash leaflets, aspen round, conifer sprays after the user's photo at a 2.5 m
  tile): height, normal and a per-leaf key (alpha: shown if the amount fallen is over it); both built in a worker.
  `litter-map.ts`: a 256 m square of half-metre texels round the camera (rebuilt every 32 m from bucketed instances, ~17 ms of main-thread work: in
  slices of ~2 ms a frame into its own arrays, published with its centre when done; `--probe=litter` times both)
  holding the kind of leaf of the crown most over each texel, the amount fallen (all crowns) and that tree's autumn
  level; the floor lays that kind's layer in that tree's colour, so the litter matches the tree above in shape and
  colour (the user). Past the square the cover map's averages. `relief.ts` is the parallax occlusion in TSL (up to
  32 steps, then 5 bisections; sampling max(floor, leaf) heights; 4 cm deep, fades by 40 m; `reliefSteps` uniform:
  `?relief=0`, off on touch, a menu switch). Litter under dense canopy or any tree's fall, within ~200 m; the meadow
  keeps its plain colour. A lone tree's litter goes by the litter map's amount alone: mixed with the cover map's over the
  map's fading edge, open ground had a brown band along the square, moving with it (the user; `meadowair` view). Gotchas in three r186's WGSL: an array texture's layer must be an `int(...).toVar()` (a
  float index fails to compile), use `.level()` not `.grad()` on it, and the needle layer's tile scale must be a
  `.toVar()` (computed inline it sampled one uniform colour). `?litterkind=0..3` forces one kind (debug). Views
  `floor`, `litterclose`, `needlesclose`, `autumn*`; `--probe=litter` reads the map round the camera.
- Terrain from high up (`terrainForAltitude` in `src/terrain.ts`, `?terrainhigh=0` off): from 350 m above the ground
  the near square is `terrain-high`, the plain ground (`applyFarFloor`: what `applyFloor` comes to past 200 m, where
  the litter, relief and moss are gone and the cobbles are their average; same image, `slope` 27 px over 8/255) on
  coarser grids, 512 cells from 1 km, 256 from 3 km, 128 from 6 km (each back at 85%). They shade with the detailed
  grid's normals and slope from a texture (`detailMap`): with their own, hills read smoother and ridges changed. The
  1024 grid is ~2M triangles, over a pixel each from 9 km on a phone, and the floor's shader computed litter and
  cobbles for every pixel and multiplied them by 0: the user's phone spent 4.3 of 15.5 ms on the terrain and sky at
  9 km. Dev GPU 1080p: `phone9k` 2.13 -> 1.03 ms, `orbitsteep` 1.54 -> 0.86, `aerial` 2.29 -> 1.48, `oblique` 2.32 ->
  1.79 (hairlines along the ridges: the coarser silhouette), `slope` 2.15 -> 1.96.
- Autumn (`src/autumn.ts`, `?autumn=` 0 = summer): broadleaf trees and bushes are green, yellow or red by stands
  (noise ranked by its sampled quantiles: 40 / 32 / 28%) plus a jitter per tree; pines stay green. The level rides in
  the instance's wind phase as whole turns (b.w = phase + 2 pi L), so no buffer grew (a 9th storage buffer would
  break the 8 limit). `autumnColour` turns the leaf colour in the hardware draw, the software resolve and the
  impostors (masked to green texels there: the atlas has bark). Fallen leaves: `forestDensity` also writes the leaves'
  amount (green 0.2, yellow 0.6, red 1, conifers `NEEDLES` 1.3 x crown) and level into the cover map's G / B (used
  past the litter map; grass thins where leaves lie thick). Views `autumnred` / `autumnyellow` / `autumngreen`, `--probe=autumn`.
  Calibrate impostor gains with `autumn=0`. From 9 km all geometry (`imppx=0`, `phone9k`) shows much less red and
  yellow than the impostors; at 1.1 km (`d1100`) both show the same stands, so it's the far geometry (sub-pixel,
  software-rasterized) that loses them, and what's drawn up there is the impostors and splats (issue #11).
- Clearings (`clearingAt` in `planting.ts`): domain-warped fbm thresholded at its sampled 90% quantile (10% of the
  land). They were a sum of sines: from the air a lattice of same-sized gaps (the user: "repetitive"; `aerial` view).
- Leaf alpha is coverage-preserving: `coverageScales()` finds, per mip level and texture layer, the alpha scale that
  keeps the full-size image's fraction of texels above the 0.5 cut-off; the leaf shader applies it by the sampled
  mip. Without it, a tree's density and brightness jump when its LOD swaps to fewer, bigger cards.
- Bark simplification weights normals/UVs (`simplifyWithAttributes`). meshopt folds attribute error into the error
  it returns, which drives LOD selection: heavier weights mean less texture popping but many more triangles
  (UVs run to ~10 along a branch). It's the normals that cost: at a quarter of their weight (`?barkattr=n,uv`
  scales) `closeup` drew ~20% fewer triangles but popped 20x more (`--sweep=lod` with `taa=0`: 57 -> 1172 jumps); the
  UV weight changes nothing. A group's error is the *max* of its children's and its own simplification's (Nanite's
  rule: each switch moves the image by at most tau; `?barkerr=sum` for the old sum, meshoptimizer's demo, the drift
  from full detail): the sum kept far trees' bark levels too fine (a 30 px oak: 2900 bark triangles, now ~350;
  `--probe=lodcut`), 35M software triangles at the user's zoomed spot (now 9M), with the same popping; -0.3..1 ms
  on every view. Lucy's `.nm` was built with the sum (rebuild with `npm run model` to change it).
- Leaf PNGs have white RGB under transparent texels; `fillTransparent` (`texture-pixels.ts`, in the texture worker) replaces it with
  the average leaf colour, otherwise mipmaps bleed pale halos into the foliage. The aspen texture is autumn-yellow and the pine
  one reads yellow in sun: both get per-layer tints in the leaf material.
- Impostors (`src/impostors.ts`): the atlas has four tiles per variant, baked from 0, 30, 60 and 90 degrees up
  (`ELEVATIONS`); the quad faces the camera and cross-fades between them by elevation as the *union* of the
  silhouettes (mixing alphas thins the forest). With only side and top tiles, trees seen from ~45 degrees were the
  top tile's dark splats (the user: "piles of poop"), and from high up the whole screen was one flat top view
  ("flat like google maps"); with the in-between tiles, off-centre trees lean outwards like real ones. A
  cylindrical billboard is edge-on from above and leaves a bald patch under the camera. Each tile's quad is
  scaled (`GROW`, `?grow=a,b,c,d`: 1, 0.9, 0.8, 0.8) so a type's impostors cover as many pixels as its real trees
  (`--typematch`'s `geo/imp px` line); the shadow quads by `?shadowgrow=` (1, 1.05, 1.45, 1.5: the real trees cast
  from coarser LODs, fat leaf cards; with the camera's sizes the ground was ~4/255 too light from 1 km up; the sun is
  32 degrees up, so only the second counts). It was 1.45-1.5 from above, fitted while half the trees were missing:
  with all drawn, crowns overlapped many deep and covered ~2x their geometry's pixels. Alpha is
  coverage-preserving per mip (`impostorCoverage` reads the atlas back once).
- Impostor coverage per type (`impCov` in `VARIANTS`: side, top, mixed by elevation; `impostorCov`, `holes` in
  `billboards.ts`): where a type still covers more than its real trees after `GROW` (Oak Large: 0.8 side, 0.6
  top; the bushes from above) its impostors get holes: the atlas cells of the mip a pixel samples (about a pixel
  each), kept with that chance, each tree its own fixed pattern, like the gaps between leaves. First it was the
  coverage dither scaled down instead, with the quads at their old size: TAA averaged the moving dither into a
  translucent smudge, the forest from ~1.5 km went blurry (the user: "not a good fix"), and because every tree
  used the same screen pattern, overlapping crowns didn't stack. A scale over 1 can't add coverage (Aspen and Oak
  Medium cover ~0.7 of their geometry from the side). Fit by reboots with `?impcovside=...&impcovtop=...` (a value
  per variant; `--typematch=cover` adjusts them live), top on `d1100`, side on `slope`/`fogline`; the types are
  coupled (thinning the oaks uncovers the ashes behind). Far below the switch (quads under 8 px wide, all of it
  from 4, `?impdrop=`) the scale becomes the share of trees drawn, solid, each fading out over 0.2 of its hash:
  those aren't listed. Mean colour vs `imppx=0` (1080p, wind 0): `d1500` +0.3/0/-1.5, `d1100` +0.8/+0.4/-0.7,
  `d550` -0.1/-0.1/-0.6, `topdown700` -0.7/-0.8/-0.9, `slope` -1.5/-1.4/-1.4, `overview` -1.1/-0.9/-1.0,
  `fogline` within 0.5, `phone9k` within 0.7.
  All geometry is not the truth far out: its sub-pixel trees thin out (the user: "without / with zoom, they are not
  the same"). The truth is the same spot through the 5x zoom (`img.ts zoom`, `--zoom=5`; the `lone` / `lone600` views:
  the loneliest tree near the test spot, 1.2 km / 600 m off). Unzoomed vs zoomed, 1600x900: impostors within
  -1.5..+2.5/255 on `zoomdown`, `topdown700`, `d1100`, `d1500`, `slope`, `lone`, `lone600`; `imppx=0` up to +9
  (`lone`: its trees nearly vanish, only their shadows left). The zoom tool once read 4/255 darker zoomed: the HUD.
- Each tree switches to its impostor at its own size (`switchPx` in `src/nanite/shading.ts`: impostorPx x a
  per-tree factor in [1/1.6, 1.6], `?impspread=`). With one threshold the switch was a line at a fixed distance
  that slid along with the camera (`--dolly` shows why: small real trees flicker in motion, impostors don't).
- Impostors cast shadows: the shadow view flags the trees it leaves as impostors, and `buildImpostorShadowMesh`
  draws their billboards turned to the sun into the shadow map. So the real map is used wherever it reaches; an
  average shadow where trees were impostors changed visibly at the switch and with the zoom. An impostor looks the
  map up on its sun side (`vShadowPos`: past its own caster quad) times the average self-shadow `?treeshade=`.
- The shadow map's side follows the drawing buffer (`fitShadowMap` in `lighting.ts`): 2048 at 1080p, a power of two
  from 512 to 2048 by sqrt(pixels), `?smap=` fixes it. A fixed 2048 at a laptop iGPU's half resolution filled 8x more
  texels than screen pixels (at its settings on the dev GPU: 5.97 -> 4.51 ms frame with 1024).
- The shadow map's extent grows with altitude (texels ~2 px at the nearest ground) up to `?shadowmax=` (6000 m
  half-extent); the light's depth range grows with it. Capped at 640 m, it was a rectangle of real shadows inside
  an evenly shaded forest seen from 1.8 km.
- Far-field shadow: past the shadow map, receivers fade to an *average* shadow instead of none (`makeFadeShadow` in
  `lighting.ts`): a constant canopy self-shadow on trees (`?treeshade=`) and forest-density darkening on the ground
  (`forestDensity`, `?groundshade=` 0.82, `?crown=`). Fading to fully sunlit made distant forest brighter, with a line
  where the map ends. Calibrate with `?farall=1` (far shading everywhere) vs the real map on `topdown700`, comparing
  mean image colour (0.7 matched the half-drawn impostors' shadows; now within 0.2 there). Keep
  `treeshade` (0.35): the impostors' own shade is it, and their gains were calibrated with it.  From high up the map is skipped: past `FAR_TEXEL` (`?fartexel=`, 5 m) texels it can't draw one
  crown's shadow, so the average blends in from half that texel size (by altitude: ~0.9-1.8 km on desktop, 0.2-0.4 km
  on a phone's 512 map) and the shadow pass and its culling stop (`shadowFarOnly`; a phone 8 km up spent ~30% of its
  GPU time on ~800k impostor shadow quads in 23 m texels). The coarse map lets light through: the average is up to
  6-8/255 darker there, blended over ~700 m of climb rather than a jump.
- Right-mouse zoom (5x) narrows `camera.fov`; LOD follows via projScale (full detail, as if 5x closer), while the
  shadow view's tau is multiplied by the zoom (shadow-map resolution doesn't change; without it shadow casters went
  to 63M tris). Zoomed into deep forest it's still ~55k trees x ~1000 tris: no occlusion culling yet.
- Impostors are *relit*, not baked lit: the bake writes an albedo atlas and a tree-local normal atlas (leaves cut
  out with Discard and alpha 1 so MSAA gives true coverage), and the impostor material is Lambert with the same
  lights, fog and shadow fade as the real leaves. Render-target textures are stored flipped (v = 1 - y).
  Colour is matched per tree type and view (side / top) by `impGain` in `VARIANTS` (`src/trees.ts`), calibrated
  after `impCov` with `npm run harness -- --typematch=calibrate --views=d1100,fogline --query="wind=0&autumn=0"`
  (masks each type with `debug=4`, compares real trees with impostors, adjusts the gains live, prints new values).
  The masks and colour shots are single frames at the same phase of the dither and jitter (`PERIOD`), jitter off,
  TAA's history dropped: averaged, a see-through crown's pixel was mostly the ground behind it, which no gain
  changes (the gains ran off to 0.1), and edge pixels blending two types read as a third. One gain for all
  types left pines as near-black stars from above. The tiles are baked from the DAG cut each tree has at the
  switch size (`dagCut`, `?bakepx=`, 0 = full detail).
- Geometry and impostor cross-fade with a screen-space dither between 1x and `FADE_HI` x the impostor pixel size.
  Impostors are never drawn narrower than `MIN_PX` (2 px): smaller trees are enlarged and a matching share dropped
  per tree, otherwise sub-pixel trees flicker on/off as the camera moves. The share kept is `(w / MIN_PX)^2`: the
  quad grows `MIN_PX / w` both ways, so that keeps the coverage (`w / MIN_PX` drew `MIN_PX / w` times the trees'
  coverage, `?impkeep=width`: ~3x from 9 km; the image barely changed, the mean colour came a little closer to all
  geometry, `imppx=0`; 1080p `orbit` 702k -> 391k impostors, -0.5 ms; the phone's 9 km view 636k -> 504k). The quads
  are indexed (`IMP_INDEX`: 4 vertex shader runs, not 6): a phone 8-9 km up spent its time by their count (35 ms for
  553k, ~20 for 317k), not by its pixels. A pixel samples only the two elevation tiles the quad blends (the ±7.5 degree bands don't
  overlap; `vBlend`: the lower tile, the upper's weight), colour and normal: 4 atlas texels, not 8 (same image;
  `slope` 2.67 -> 2.12 ms, `fogline` -0.4, `topdown700` -0.3, 9 km -0.3 on the dev GPU). The instance pass already leaves out the
  ones sure to be dropped (`_impostorKept`: the quad's test at its widest enlargement); listed, they collapsed in the
  vertex shader: from 9 km up the user's phone drew 898k impostors for a 288x521 screen and phase 2 retested them
  all (`phonetop` at the phone's size: 1.35M listed -> 375k, same image).
- The impostor draws (view and shadow map) have one instance per entry of the view's impostor list (`impListAttr`,
  count in the counters at `IMP_ARGS`, the indirect args). The main view's is appended by phase 2 for the impostors
  that pass its occlusion test (`impRetest`: phase 1 appends them itself when phase 2 won't run: `willOcclude`).
  It was a flag per instance with a draw over all 2.5M instances x 6 vertices (twice), collapsing the unflagged:
  a fixed cost no quality setting touched (the user's Mac at 4 fps; 4070 Ti ground view 6.6 -> 4.1 ms at tau 8).
  An earlier note said appending was slower (900k threads on one atomic, ~5 ms): phase 2 appends only the visible
  few thousand, and the retest list was already appending every impostor in view.
- Until issue #30 half the trees (hash > 0.5, the mirrored ones) had no impostor: their quads were drawn with zero
  width (TSL built the corner's x inside the mirroring's `select` branch, and the position read it unset: look for a
  var assigned in one branch only in the WGSL when a node first used inside a `select`/`If` is used again outside
  it; `.toVar()` it first), so they faded out at the switch and every calibration was done without them. Found by
  rendering one tree alone in both paths (the splats below drew it, the quads didn't). All drawn and recalibrated
  (`GROW`, `shadowgrow`, `impCov`, `impGain`, `groundshade`): before, the forest read up to 2.8/255 off all geometry
  (`d1100` +1.6/-2.8/-2.6, `topdown700` -0.7/-2.7/-2.1) with the mid-distance stands visibly gappy. More quads
  cost (render GPU, 1080p, dev GPU, production builds): `overview` +0.9, `slope` +0.75, `fogline` +0.55, `canopy`
  +0.33, `topdown` +0.1, `d1500` +0.04 ms, ground views and `orbit` (splats) +0; at the phone's size `overview`
  +0.55, `slope` +0.33, `topdown` and `phone9k` -0.2. Motion: `--dolly` slope 32 -> 11 flicker events, fogline the
  same, `--sweep=lod` a little fewer jumps.
- Tiny impostors are splatted in compute (`src/nanite/splats.ts`, Nanite's way with tiny triangles): from
  `?splatalt=` (2 km) above the ground the instance pass lists an impostor under `?splatpx=` (3) px wide in the
  impostor list from its top down (another buffer would be a 9th in the instance pass), and one thread per splat
  walks its quad's pixels in the software rasterizer's visibility buffer (depth atomicMin, then the id with
  `SPLAT_BIT`), as the quad would be drawn: size, elevation tiles, `MIN_PX` and thinning, the atlas alpha by
  coverage against `ditherAlt`. A fullscreen resolve (phase 2 layer) shades those pixels as the impostor material
  does (normal atlas, gains, tint, autumn, shadow, fog). One depth per splat (its centre's), so where two overlap
  the nearer centre wins. Same image as the quads (`phone9k`: means within 0.1/255, isolated trees pixel for pixel);
  dev GPU at the phone's size render 0.95 -> 0.59 ms, compute +0.21 (`orbit` at 1080p 0.94 -> 0.84); below 2 km
  they cost more than they save on the dev GPU (`topdown` 1.8 km +0.06 ms; ~0.05 ms with none at all). `?splat=0`,
  the profile's `imp splats off`; debug 5 shows them cyan. A phone's quads cost by their count (vertex work), so
  its report is the measure.
- Shadow casters' LOD: by the camera's pixels at `SHADOW_TAU_MUL` (5, `?shadowtau=`) x tau; at 2.5 they were 9M
  triangles at full detail (the trees all round, for ~11 cm texels), at 5 half, same image. A texel floor (no caster
  finer than a shadow texel) changed nothing: few casters are that close.
- Shadow casters only where their shadow can land in the camera's view (`CastTest` in `chunks.ts`, the shadow view's
  `sphereVisible`, `castLen` in `forest.ts`): each chunk box, tree and cluster, swept away from the sun far enough
  for the tallest tree's shadow to reach ground 60 m lower, must touch the camera's frustum. The map covers a square
  around where the camera looks, kilometres wide from high up, and every caster in it was drawn: zoomed in looking
  down from 544 m (`zoomdown --zoom=5`) 38M shadow triangles, 13 ms of a 17.9 ms frame (now 258k, 4.75 ms); on the
  ground a third to half of the casters, -0.3..0.65 ms; images match but for scattered specks (`img.ts diff`).
  `?castcull=0` for the old.
- Software rasterizer (`src/nanite/softraster.ts`, main view only): the cluster pass sends clusters whose triangles
  average under `swArea` px² (`?swarea=`, default 4; `?sw=0` = hardware only) to a list that compute passes
  rasterize into a visibility buffer: atomicMin of view depth, then atomicMax of (slot, triangle) + 1 where the
  depth matches (no 64-bit atomics in WebGPU). A fullscreen quad on the phase 2 layer (`buildResolveMesh`) rebuilds
  each pixel's triangle and shades it with a Lambert material whose normal, shadow position and depth are
  overridden; fog is applied in its `outputNode`. Don't give its shared nodes names (`toVar('x')`): three.js
  builds the normal in a separate sub-build that re-declares them, and the pixels came out black. Leaves emulate
  three.js alpha to coverage (`smoothstep(0.5, 0.5 + fwidth(a), a)` against a fixed per-pixel threshold): a plain
  0.5 cut made distant crowns solid. Check with `?debug=5` (software pixels orange) and `--ab="sw=0|sw=1"` (mean
  colours should agree). Not in the HZB (it's built before) and not used for the shadow map yet. Only from 25 m above
  the ground up (`?swalt=`, 0 = everywhere; `sw.idle`, off again under 70% of it): it costs ~0.36 ms a frame whatever
  it takes and computes each triangle's vertices in both walks, and down there the far trees it's for are mostly
  hidden (High, 1080p: 0.3-0.4 ms slower on `plazane`/`ground`/`closeup`, even on `treeline` at 30 m, 0.4-0.8 faster on
  `canopy`/`fogline`/`slope`/`overview`). Compare it on the ground with `swalt=0`.
- No MSAA under TAA (`samples` in `main.ts`; WebGPU has 1 or 4): the hardware leaves do alpha to coverage with one
  sample, three.js's `smoothstep(0.5, 0.5 + fwidth(a), a)` against the moving `ditherAlt` (`a2cDither` in
  `shading.ts`), so only each leaf's 1 px edge is dithered and TAA averages it. 4x MSAA cost ~2.5 ms on High at 1080p
  on the user's 4070 Ti (`plazane` 10.3 -> 8.6 ms frame, `canopy` 15.8 -> 12.7; same mean colours and turning
  flicker). Not the plain filtered alpha as a probability: every card stacked in a pixel passed the same threshold,
  so crowns didn't add up (pale, see-through) and their holes left the HZB nothing to occlude with. A plain 0.5
  cut-out with one sample makes crowns solid and dark. 4x with `?taa=0`, `?leafalpha=a2c` or `?msaa=4`.
- Temporal upscaling (`src/resolution.ts`, `src/taa.ts`; `?taau=0` off, `?outpr=`): the canvas at the device's
  pixel ratio (up to 3), the scene at auto quality's (`?pr=`, the device's up to 1.5, times the scale). Before, the
  canvas itself was rendered small and the browser stretched it: a DPR 3.75 phone at 1.5 (60% at start) showed each
  pixel 2.5-4 screen pixels wide (the user: "blurry, no detail"). The history is at the canvas's size; each output
  pixel gathers the 3x3 scene samples round its centre, weighted `exp(-k d^2 / ratio)` by their jittered distance in
  output pixels (`?taakernel=` k, 5): the nearest sample alone speckled, k 2.29 (UE's Blackman-Harris fit) softened
  the native image. The history's alpha holds the weight it has gathered, capped at (frames x ratio - 1) x a frame's
  mean (`maxWeight`): upscaled, an output pixel gets a near sample only every ratio^2 frames, and 10 frames' worth
  shimmered at 3x on the user's phone (66% at 9 km: "shimmer instead of blurry"; still `canopy` 566 -> 194 events,
  turning 15679 -> 12526); a clipped or uncovered pixel still takes new samples quickly. The jitter cycles 8 x ratio^2 Halton offsets (every output pixel gets near samples). Its sign: the
  projection offset moves the image left by jx and down by jy, so a sample sees what was jx right of and jy above its
  texel's centre (`jitterOff`); the other signs reconstruct 15-40% further from native. Textures get a mip bias of
  log2(scene / output pixels) (`mipBias` in `shading.ts`: bark, leaves, impostors, the software rasterizer;
  `footprint()` scales the floor's and the cobbles' derivatives); 0 with TAA off. At native resolution it flickers less
  turning than the old resolve (slope 1340 -> 1294, fogline 2359 -> 2266), same cost. At the phone's settings on the dev
  GPU (`--size=384x832 --dpr=3 --query=touch=1`: 576x1248 -> 1152x2496) +0.15-0.3 ms; rendering at 3x instead
  costs twice. Trees' LOD and the impostor sizes still go by the scene's pixels.
- Temporal anti-aliasing (`src/taa.ts`, `?taa=0` / T to turn off): the camera is jittered by a sub-pixel Halton
  offset each frame (`?taajitter=`: the whole pixel, half with MSAA, which does the geometric edges) *before* culling, so the
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
- God rays (`src/godrays.ts`, R, `?rays=` strength, `?raydecay=`, `?rayfall=` fade with the distance from the sun
  on screen: without it a sun just above the view washed the whole screen, the user's phone too): screen-space radial march towards the sun over
  the depth buffer at half resolution, open sky near the sun's disc as the source. Added to the scene colour inside
  the TAA resolve (`TAA`'s `extra`), so its per-pixel jittered march start is averaged: added after TAA, the
  40-sample march left stair-steps along the shafts. `sunrays` view (sun behind the canopy). Clouds don't block it.
- The output's unsharp mask runs in x/(1+x): in linear HDR it made a black ring round the sun.
- Walking (`src/controls.ts`): on the ground at eye height 1.7 m with gravity; Space jumps, Space again in the air
  flies; flying down onto the ground walks again. Off under the harness (views are placed in the air) unless
  `?walk=1`; `--probe=walk --query=walk=1` checks it.
- Touch controls (`src/touch.ts`, GitHub issue #1): a floating stick under the left thumb, look drag on the right,
  hold buttons for up / down / zoom; they feed `FlyControls.analog` and yaw/pitch. On by `(pointer: coarse)`, or
  `?touch=1|0`; the harness only with `touch=1` (`--probe=touch` fires synthetic finger events and checks each
  control responds).
- The scene target's alpha is not shown: the output pass writes alpha 1. Alpha-to-coverage leaves left alpha < 1
  there, and the canvas showed the light-blue page background through them (the whole forest read paler and bluer).
- **Storage buffers per shader: at most 8** (WebGPU's guaranteed minimum; a Mac allowed fewer than our shaders
  bound, and the cluster passes failed: only impostors, "semitransparent trees"). Hence the merged buffers: per
  tree one `inst` buffer (2 vec4s, `_a`/`_b`), per vertex one `vtx` (`_vtx`), per cluster 5 vec4s in `cData` with
  the meta bit-cast in the 5th (`_cd`/`_meta`), one list buffer per set (bark, then leaves), and per view one
  counters buffer (`makeCounters` in `constants.ts`: draw args at offsets, stats, item count, retest and
  software-raster counts). A shader uses one access mode of the counters (`atomic` + atomicLoad where it reads and
  adds). Check new passes with `?maxsb=8` (caps the device limit): no validation errors in `console.log`.
- Occlusion culling (`src/nanite/culling.ts`, `hzb.ts`, main view only): two phases per frame. Phase 1 tests trees and clusters
  against *last* frame's HZB (built with last frame's camera, read through the same uniforms before they're
  updated) and draws what passes; `occlusion()` then rebuilds the HZB from this frame's depth (max over each
  pixel's samples, `sceneRT.depthTexture`) and retests the failures; what's visible is drawn by the phase 2
  meshes (layer `PHASE2_LAYER`, a second `renderer.render` with autoClear and shadow updates off). Impostors are
  drawn there too, tested once against this frame's HZB (they're listed in the retest list with `IMP_BIT`; hidden
  ones get their flag cleared). Clouds are on that layer too, so they're drawn after every tree. Check with the
  `bark` view (one trunk fills the screen): occlusion off draws 67M tris, on ~0.6M. Only below `OCC_ALTITUDE` (150 m above the
  ground, `?occalt=`; `forest.occlusionOn` is the menu's switch): from above little hides anything and its passes
  cost (260 m up 0.24 ms, 8.8 km 0.4, a phone 9%), and the gap closing culled some visible 2-3 px trees (the user:
  "disappearing trees when going up"). Foliage's gaps let far depth
  into every block of a max pyramid: on the ground 86% of the drawn triangles were hidden (`--probe=visible
  --query=ids=1`). Gaps up to 2 px are closed before it's built (`HZB_CLOSE`, `?hzbclose=`: not conservative, 1% of
  the seen triangles lost, no added flicker; -0.6..0.9 ms on the ground). A test reads 8x8 texels (`HZB_TAPS`) at a
  level where the rect spans at most 8; spheres grow by the wind's reach at the part's height (`windMargin`: it was
  10% of the tree + 0.5 m for every part). `--probe=cullcheck` sorts what's still drawn but unseen. The HZB lookup reads up to 4x4 texels of a finer level than
  usual: at 2x2 the texels near the horizon take in sky and nothing is ever occluded.
