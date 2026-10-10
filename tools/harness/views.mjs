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
