// The harness's fixed viewpoints. x/z are world metres; the height is either `agl` (above the ground there) or `y`
// (absolute); yaw/pitch are degrees. `nearTree` frames the closest tree from that many metres away; `trunk` faces
// the closest tree's trunk, level, from that many metres off its axis.
// Add a view here (not in a probe) when a problem needs to be looked at again: every command can then use it.
export const VIEWS = {
  // in and over the forest
  ground: { x: 20, z: 40, agl: 1.8, yaw: 30, pitch: 4 },
  // grass up close, half a metre up (user: "grass up close is not very detailed"; blades, the floor's relief)
  grassclose: { x: 20, z: 40, agl: 0.5, yaw: 30, pitch: -14 },
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
  // straight down on the plaza from 60 / 150 m (user: some statues vanished from up high)
  plazatop: { x: -30.2, z: -47, agl: 60, yaw: 30, pitch: -89 },
  plazahigh: { x: -30.2, z: -47, agl: 150, yaw: 30, pitch: -89 },
  // the road from the spawn point, from above and behind
  roadair: { x: 45, z: 85, agl: 40, yaw: 30, pitch: -25 },
  // the spawn point turned away from the road: the waypoint (src/waypoint.ts, --query=waypoint=1) on the screen's edge
  spawnback: { x: 20, z: 40, agl: 1.8, yaw: 160, pitch: 4 },
  // a statue up close (a million triangles: Nanite detail)
  statue: { x: -23.7, z: -35.8, agl: 2, yaw: 210, pitch: 14 },
  overview: { x: 0, z: 700, agl: 260, yaw: 0, pitch: -22 },
  horizon: { x: -300, z: -300, agl: 30, yaw: 135, pitch: -2 },
  high: { x: 120, z: 160, agl: 70, yaw: 200, pitch: -40 },
  treeline: { x: 0, z: 1500, agl: 30, yaw: 0, pitch: -4 }, // distant treeline against the sky (LOD popping)
  fogline: { x: 0, z: 2600, agl: 120, yaw: 0, pitch: -7 }, // geometry -> impostor switch near the fog
  zoomref: { x: 0, z: 2600, agl: 300, yaw: 0, pitch: -6 }, // grazing view over the canopy (use with --zoom=5)
  // altitude and clouds
  belowclouds: { x: 0, z: 3000, y: 1500, yaw: 10, pitch: 8 },
  inclouds: { x: 0, z: 3000, y: 2260, yaw: 10, pitch: -5 },
  aboveclouds: { x: 0, z: 4000, y: 3200, yaw: 0, pitch: -12 },
  orbit: { x: 0, z: 9000, y: 8800, yaw: 0, pitch: -28 },
  oblique: { x: 0, z: 2600, agl: 1200, yaw: 0, pitch: -35 },
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
};

/** The views run when --views isn't given: the everyday set, not every special-purpose one. */
export const DEFAULT_VIEWS = ['ground', 'closeup', 'canopy', 'overview', 'horizon', 'high', 'orbit', 'topdown'];
