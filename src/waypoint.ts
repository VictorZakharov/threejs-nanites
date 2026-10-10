// A game-style waypoint to the middle of the statue plaza (src/road.ts; the user: "an animated waypoint towards the
// centre of the square"): a bobbing diamond with a pulsing ring and the distance, over the spot 3 m above the
// ground. Off screen (or behind) it sits on the screen's edge with an arrow pointing the way. It fades out as you
// arrive. An HTML overlay (crisp at any resolution, animated by CSS): `#waypoint`, a menu switch; hidden under the
// harness unless ?waypoint=1.
import * as THREE from 'three/webgpu';
import { PLAZA } from './road.ts';
import { heightAt } from './terrain.ts';

const LIFT = 3; // m above the ground
const ARRIVE = 10; // m: fully faded at the plaza's middle, from here in
const MARGIN = 48; // px from the screen's edge when clamped

export function createWaypoint(hidden: boolean) {
  const el = document.createElement('div');
  el.id = 'waypoint';
  el.innerHTML = '<div class="wp__arrow"></div><div class="wp__mark"><i></i><b></b></div><span></span>';
  if (hidden) el.classList.add('hidden');
  document.body.appendChild(el);
  const arrow = el.querySelector<HTMLElement>('.wp__arrow')!, label = el.querySelector('span')!;
  const target = new THREE.Vector3(PLAZA.x, heightAt(PLAZA.x, PLAZA.z) + LIFT, PLAZA.z);
  const v = new THREE.Vector3();
  let lastText = '';

  return {
    update(camera: THREE.PerspectiveCamera): void {
      if (el.classList.contains('hidden')) return;
      const dist = Math.hypot(camera.position.x - target.x, camera.position.z - target.z);
      v.copy(target).applyMatrix4(camera.matrixWorldInverse);
      const behind = v.z > 0;
      v.applyMatrix4(camera.projectionMatrix); // (NDC; mirrored when behind)
      let x = behind ? -v.x : v.x, y = behind ? -v.y : v.y;
      const w = innerWidth / 2, h = innerHeight / 2;
      const ex = 1 - MARGIN / w, ey = 1 - MARGIN / h;
      const off = behind || Math.abs(x) > ex || Math.abs(y) > ey;
      if (off) {
        // onto the edge, along the direction from the screen's middle (behind: pushed out from it)
        if (behind && Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3) y = -1;
        const s = Math.min(ex / Math.max(Math.abs(x), 1e-6), ey / Math.max(Math.abs(y), 1e-6));
        if (behind || s < 1) (x *= s), (y *= s);
        arrow.style.transform = `rotate(${Math.atan2(-y * h, x * w)}rad)`;
      }
      el.classList.toggle('wp--off', off);
      el.style.transform = `translate(${(x + 1) * w}px, ${(1 - y) * h}px)`;
      el.style.opacity = String(THREE.MathUtils.clamp((dist - ARRIVE) / ARRIVE, 0, 1));
      const text = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`;
      if (text !== lastText) label.textContent = lastText = text;
    },
  };
}
