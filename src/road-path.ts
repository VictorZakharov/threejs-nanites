// The cobblestone road's shape (src/road.ts has the rest): from the spawn point, winding to a round paved plaza ringed
// by statues; and the distance to the paving. Plain TypeScript: the planting workers use it too.

export const ROAD_WIDTH = 3.6; // m
export const SPAWN = { x: 20, z: 40, yaw: 30 }; // (main.ts's start: looking down the road)
const LENGTH = 80; // (240 at first: the user wanted it 3x shorter)
const fwd = { x: -Math.sin((SPAWN.yaw * Math.PI) / 180), z: -Math.cos((SPAWN.yaw * Math.PI) / 180) };
const side = { x: -fwd.z, z: fwd.x };

/** The road's centre line, spawn to plaza (a gentle S, straight at both ends). */
export const ROAD: { x: number; z: number }[] = Array.from({ length: 33 }, (_, i) => {
  const t = i / 32, along = (t - 0.02) * LENGTH;
  const wiggle = Math.sin(t * Math.PI) ** 2 * Math.sin(t * Math.PI * 2) * LENGTH * 0.11;
  return { x: SPAWN.x + fwd.x * along + side.x * wiggle, z: SPAWN.z + fwd.z * along + side.z * wiggle };
});
/** The plaza at the road's end: paved radius, and the circle the statues stand on. */
export const PLAZA = (() => {
  const end = ROAD[ROAD.length - 1];
  return { x: end.x + fwd.x * 22, z: end.z + fwd.z * 22, radius: 24, ring: 17, statues: 12 };
})();

// (the paving's bounding box: placement asks for millions of candidates, nearly all far away: looping over every
// segment for each was most of the 7 s it took to plant the forest)
const NEAR = 50; // m: past this outside the box, roadDistance only promises "at least this far"
const bounds = (() => {
  const xs = [...ROAD.map((p) => p.x), PLAZA.x - PLAZA.radius, PLAZA.x + PLAZA.radius];
  const zs = [...ROAD.map((p) => p.z), PLAZA.z - PLAZA.radius, PLAZA.z + PLAZA.radius];
  return { x0: Math.min(...xs) - ROAD_WIDTH, x1: Math.max(...xs) + ROAD_WIDTH, z0: Math.min(...zs) - ROAD_WIDTH, z1: Math.max(...zs) + ROAD_WIDTH };
})();

/** Metres from (x, z) to the paving's edge (road or plaza), negative on it; anything over NEAR (50 m) may read as NEAR. */
export function roadDistance(x: number, z: number): number {
  const out = Math.max(bounds.x0 - x, x - bounds.x1, bounds.z0 - z, z - bounds.z1);
  if (out > NEAR) return out;
  let d = Math.hypot(x - PLAZA.x, z - PLAZA.z) - PLAZA.radius;
  for (let i = 0; i + 1 < ROAD.length; i++) d = Math.min(d, segmentDistance(x, z, i));
  return d;
}

/** Metres from (x, z) to the edge of the road's segment i (ROAD[i] to ROAD[i + 1]), negative on it. */
export function segmentDistance(x: number, z: number, i: number): number {
  const a = ROAD[i], b = ROAD[i + 1];
  const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
  const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2));
  return Math.hypot(x - a.x - ex * t, z - a.z - ez * t) - ROAD_WIDTH / 2;
}
