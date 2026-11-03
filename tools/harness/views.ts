// The harness's fixed viewpoints. x/z are world metres; the height is either `agl` (above the ground there) or `y`
// (absolute); yaw/pitch are degrees. `nearTree` frames the closest tree from that many metres away; `trunk` faces
// the closest tree's trunk, level, from that many metres off its axis.
// Add a view here (not in a probe) when a problem needs to be looked at again: every command can then use it.
import type { HarnessView } from '../../src/harness-api.ts';

export const VIEWS: Record<string, HarnessView> = {
  // in and over the forest
  ground: { x: 20, z: 40, agl: 1.8, yaw: 30, pitch: 4 },
  // grass up close, half a metre up (user: "grass up close is not very detailed"; blades, the floor's relief)
  grassclose: { x: 20, z: 40, agl: 0.5, yaw: 30, pitch: -14 },
  // a clearing ~350 m from the spawn (grass in the open: tufts, blade shapes, sun and shade), eye level and close up
  meadow: { x: 150, z: 290, agl: 1.7, yaw: 30, pitch: -4 },
  meadowclose: { x: 165, z: 310, agl: 0.6, yaw: 30, pitch: -18 },
  // over the clearing from 30 m (the user: a brown square on the ground that moved along: the litter map's edge)
  meadowair: { x: 150, z: 290, agl: 25, yaw: 210, pitch: -10 },
  // 4 m up over the clearing, the rings' hand-over at 13-16 m mid-screen (the user: "a line, only seen moving")
  meadowlow: { x: 150, z: 290, agl: 4, yaw: 30, pitch: -12 },
  closeup: { x: 0, z: 0, agl: 3, yaw: 0, pitch: 10, nearTree: 7 },
  // the screen filled by one trunk: occlusion culling should leave only that tree (see --probe=occlusion)
  bark: { x: 0, z: 0, agl: 1.5, yaw: 0, pitch: 0, trunk: 1.5, zoom: 5 },
  canopy: { x: -50, z: 200, agl: 45, yaw: -20, pitch: -6 },
  // treetops against the sky from below (user: "ghosted peaks": pale pine tips)
  peaks: { x: 560, z: 120, agl: 12, yaw: 0, pitch: 4 },
  // into the sun through the trees (god rays)
  sunrays: { x: 90, z: 120, agl: 1.8, yaw: 35, pitch: 26 },
  // the forest floor up close under the canopy, looking down (leaf litter, parallax relief: src/ground/)
  floor: { x: 90, z: 120, agl: 1.8, yaw: 35, pitch: -55 },
  // inside a red / yellow / green stand, looking down a little: the trees' autumn colours and the leaves under them
  // (src/autumn.ts; spots from --probe=autumn)
  autumnred: { x: -79, z: 33, agl: 1.8, yaw: 200, pitch: -22 },
  autumnyellow: { x: -190, z: -5, agl: 1.8, yaw: 200, pitch: -22 },
  autumngreen: { x: -293, z: 13, agl: 1.8, yaw: 200, pitch: -22 },
  // under conifers: a thick mat of rust-brown sprays (user's photo)
  autumnpine: { x: 301, z: -222, agl: 1.8, yaw: 200, pitch: -22 },
  needlesclose: { x: 301, z: -222, agl: 0.6, yaw: 200, pitch: -60 },
  // the litter from 60 cm, steeply down, under the red stand (leaf shapes)
  litterclose: { x: -79, z: 33, agl: 0.6, yaw: 200, pitch: -60 },
  // the cobblestone road's end, looking into the plaza with its ring of statues (src/road.ts); the plaza from the air
  plaza: { x: -19.2, z: -28, agl: 1.8, yaw: 30, pitch: 6 },
  plazaair: { x: -5.2, z: -3.7, agl: 30, yaw: 30, pitch: -28 },
  // the user's 4070 Ti report (111 fps at tau 8, 85%): in the plaza walking, looking back along the road
  plazaback: { x: -34, z: -54, agl: 1.7, yaw: 152.8, pitch: -7.7 },
  // the user's second 4070 Ti report (80 fps on High: tau 1, 1920x1080): in the plaza looking north-east
  plazane: { x: -36, z: -53, agl: 1.7, yaw: 59.8, pitch: 3.8 },
  // straight down on the plaza from 60 / 150 m (user: some statues vanished from up high)
  plazatop: { x: -30.2, z: -47, agl: 60, yaw: 30, pitch: -89 },
  plazahigh: { x: -30.2, z: -47, agl: 150, yaw: 30, pitch: -89 },
  // the road from the spawn point, from above and behind
  roadair: { x: 45, z: 85, agl: 40, yaw: 30, pitch: -25 },
  // the spawn point turned away from the road: the waypoint (src/waypoint.ts, --query=waypoint=1) on the screen's edge
  spawnback: { x: 20, z: 40, agl: 1.8, yaw: 160, pitch: 4 },
  // a statue up close (a million triangles: Nanite detail)
  // the Lucy scene (--scene=lucy): a 2.9 x statue's face from 3 m (the user: "is it supposed to be that non-detailed?")
  // the Lucy scene from 60 m: statues and their shadows (the user: "zoomed out, they drop shadow in another direction")
  lucyshadow: { x: 20, z: 40, agl: 60, yaw: 30, pitch: -40 },
  lucyface: { x: 48.1, z: 38.5, y: 4.6, yaw: 29.3, pitch: 0 },
  // straight down over a 79 m statue (scale 19.8), climbing: its shadow by altitude (the user: "look directly down,
  // and move up... see how shadows change"; a gap at its base, the shadow changing with the zoom)
  ...Object.fromEntries([150, 300, 600, 1200, 2400].map((agl) => [`giant${agl}`, { x: 29, z: -223, agl, yaw: 0, pitch: -89.9 }])),
  // straight down over a 6 m statue (scale 1.56) through the zoom, climbing (the user: "pick a small statue from far
  // with full shadow, then move up, looking directly down")
  ...Object.fromEntries([50, 100, 200, 400, 800, 1600].map((agl) => [`small${agl}`, { x: 99.5, z: -154.8, agl, yaw: 0, pitch: -89.9, zoom: 5 }])),
  // over the statues towards the horizon, 120 m up (the user: "a circle where statues gain their brightness")
  lucyhorizon: { x: 400, z: 250, agl: 120, yaw: 20, pitch: -10 },
  userzoom: { x: 20, z: 40, agl: 372, yaw: 25.8, pitch: -13.6 }, // (the user's report: wings change ~1 s after the zoom)
  userpan: { x: 20, z: 40, agl: 292, yaw: 31.7, pitch: -10.4 }, // (the user's report: panning while zoomed drops the fps)
  userzoom2: { x: 28, z: 27, agl: 397, yaw: -123.5, pitch: -15.8 }, // (and after the zoom's fixed ease: "some statues still grow wings")
  lucyfield: { x: 400, z: 250, agl: 34, yaw: 20, pitch: -4 }, // across the statues, as the user zoomed (34 m up)
  statue: { x: -23.7, z: -35.8, agl: 2, yaw: 210, pitch: 14 },
  overview: { x: 0, z: 700, agl: 260, yaw: 0, pitch: -22 },
  horizon: { x: -300, z: -300, agl: 30, yaw: 135, pitch: -2 },
  high: { x: 120, z: 160, agl: 70, yaw: 200, pitch: -40 },
  treeline: { x: 0, z: 1500, agl: 30, yaw: 0, pitch: -4 }, // distant treeline against the sky (LOD popping)
  fogline: { x: 0, z: 2600, agl: 120, yaw: 0, pitch: -7 }, // geometry -> impostor switch near the fog
  userstill: { x: 20, z: 40, agl: 239, yaw: 110, pitch: -6.5 }, // (the user's report: zoomed, held still, side-on to the sun, statues flicker: T stops it)
  userzoomin: { x: 0, z: 8, agl: 368, yaw: 34.2, pitch: -13.6 }, // (the user's report: triangles spike mid-zoom)
  laptop: { x: 20, z: 40, agl: 193, yaw: 14.2, pitch: -38.6 }, // (the user's $700 laptop, Intel Xe2-LPG: 39 fps in the forest, 27 ms GPU at half resolution)
  laptoplucy: { x: 20, z: 40, agl: 227, yaw: -8.6, pitch: -34.8 }, // (and 51 fps in the Lucy forest, 14 ms)
  zoomref: { x: 0, z: 2600, agl: 300, yaw: 0, pitch: -6 }, // grazing view over the canopy (use with --zoom=5)
  // altitude and clouds
  belowclouds: { x: 0, z: 3000, y: 1500, yaw: 10, pitch: 8 },
  inclouds: { x: 0, z: 3000, y: 2260, yaw: 10, pitch: -5 },
  aboveclouds: { x: 0, z: 4000, y: 3200, yaw: 0, pitch: -12 },
  orbit: { x: 0, z: 9000, y: 8800, yaw: 0, pitch: -28 },
  // the user's README screenshot (8965 m up, the plaza 5.5 km ahead: 605 plants drawn as geometry, 46k software triangles)
  orbitsteep: { x: 0, z: 5500, agl: 8965, yaw: 0, pitch: -48 },
  // the user's 4070 Ti report: right-mouse zoom over the canopy into the distance, frames to 20 ms (p95 21.8, 278k
  // impostors, 7.3M software triangles, compute 3.6 ms); use with --zoom=5
  canopyzoom: { x: -1336, z: 756, agl: 193, yaw: -164.5, pitch: -7 },
  // the user's desktop zoom looking down from 544 m (washed out: auto at tau 8 and 50%, GPU 7.4 = 2.7 draw + 4.6
  // cull, 14.2M shadow triangles); use with --zoom=5
  zoomdown: { x: -1336, z: 756, agl: 544, yaw: -164.5, pitch: -70 },
  // the user's desktop zoom from 478 m at a moderate angle (2026-10-11: "washed"; auto at tau 8 and 66%, GPU 5.5 =
  // 4.0 draw + 1.5 cull, 97k plants, 80k impostors, 3.3M triangles at 1270x714); use with --zoom=5
  zoommid: { x: -1336, z: 756, agl: 478, yaw: -164.5, pitch: -22 },
  // the user's Samsung S25 report (20 fps "all the way up": 898k impostors listed for a 288x521 screen), straight down
  phonetop: { x: 20, z: 40, agl: 9004, yaw: -0.7, pitch: -85.7 },
  phone9k: { x: 20, z: 40, agl: 9004, yaw: 26.7, pitch: -82 }, // (the phone's report at 9 km, 576x1248: --size=384x832 --query="touch=1&pr=1.5&tau=8")
  oblique: { x: 0, z: 2600, agl: 1200, yaw: 0, pitch: -35 },
  // looking 45 degrees down from high up (the user's zoom that redrew and went back: --zoomtime)
  down300: { x: 0, z: 1200, agl: 300, yaw: 0, pitch: -45 },
  down800: { x: 0, z: 1600, agl: 800, yaw: 0, pitch: -45 },
  down1500: { x: 0, z: 2200, agl: 1500, yaw: 0, pitch: -45 },
  down3000: { x: 0, z: 3500, agl: 3000, yaw: 0, pitch: -45 },
  down6000: { x: 0, z: 6500, agl: 6000, yaw: 0, pitch: -45 },
  // looking down (impostor top views, coverage)
  // the forest from ~2.5 km at an angle (user: "from up top pattern of trees looks repetitive")
  aerial: { x: 0, z: 2500, agl: 2500, yaw: 0, pitch: -50 },
  topdown: { x: 400, z: 600, agl: 1800, yaw: 0, pitch: -80 },
  topdown700: { x: 400, z: 600, agl: 500, yaw: 0, pitch: -80 },
  d1500: { x: 400, z: 600, agl: 1500, yaw: 0, pitch: -89 },
  d1100: { x: 400, z: 600, agl: 1100, yaw: 0, pitch: -89 },
  d800: { x: 400, z: 600, agl: 800, yaw: 0, pitch: -89 },
  d550: { x: 400, z: 600, agl: 550, yaw: 0, pitch: -89 },
  d350: { x: 400, z: 600, agl: 350, yaw: 0, pitch: -89 },
  // looking down at 40 degrees: trees ~12 px tall (impostors), ~60 px through the 5x zoom (user: "piles of poop")
  slope: { x: 400, z: 600, agl: 450, yaw: 0, pitch: -40 },
  // the loneliest tree near (400, 600) (no plant within up to 48 m), 1.2 km off and 30 degrees up: one impostor alone
  // on the ground, to compare with its geometry (imppx=0) and through the zoom (the user: "pick a single tree... go far
  // out... then zoom in 5x")
  lone: { x: 400, z: 600, lone: 1200, yaw: 0, pitch: -30 },
  lone600: { x: 400, z: 600, lone: 600, yaw: 0, pitch: -30 },
  // the loading screen's pictures (public/thumbs): the same tree from 18 m and a statue of the Lucy forest, each against
  // the sun (it's at yaw ~35, 32 degrees up): the tree in god rays
  thumbtree: { x: 400, z: 600, lone: 18, yaw: 35, pitch: 15 },
  // (--scene=lucy: the closest statue to (50, 30) from 7 m, the sun right behind her: a silhouette in its halo, against the sky)
  thumblucy: { x: 50, z: 30, agl: 0.6, yaw: 35, nearTree: 7 },
  // the same statue's foot from the side, its shadow running across the view (does the shadow start at the foot?)
  lucyfoot: { x: 50, z: 30, agl: 7, yaw: 125, nearTree: 4, aim: 0 },
  // the same tree from 8 sides as lone600 (600 m off, 30 degrees up), through the zoom (the impostor is baked from one side:
  // `--typematch --views=lone0,lone45,...` compares its pixels and colour with the geometry's from each)
  ...Object.fromEntries([0, 45, 90, 135, 180, 225, 270, 315].map((yaw) => [`lone${yaw}`, { x: 400, z: 600, lone: 600, yaw, pitch: -30, zoom: 5 }])),
};

/** The views run when --views isn't given: the everyday set, not every special-purpose one. */
export const DEFAULT_VIEWS = ['ground', 'closeup', 'canopy', 'overview', 'horizon', 'high', 'orbit', 'topdown'];
