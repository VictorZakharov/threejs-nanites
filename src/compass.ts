// The compass strip at the top of the screen (the user: "a compass on top like a HUD, with that waypoint too"): a
// tape of headings (N / E / S / W, ticks every 15 degrees, numbers every 45) sliding under a fixed centre mark, and
// the plaza's waypoint (src/waypoint.ts) on it at its bearing, pinned to the strip's end with an arrow when it's
// outside the strip's 180 degrees. North is -z (yaw 0), east +x. Only while walking (the user: not when flying).
// `#compass`, a menu switch; hidden under the harness unless ?waypoint=1 (and walking: ?walk=1).
import * as THREE from 'three/webgpu';

const SPAN = 180; // degrees across the strip
const LETTERS: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

export function createCompass(target: THREE.Vector3, hidden: boolean) {
  const el = document.createElement('div');
  el.id = 'compass';
  // the tape runs -360..720 so any heading's +-90 degrees are on it
  let ticks = '';
  for (let d = -360; d <= 720; d += 15) {
    const h = ((d % 360) + 360) % 360, pos = `left:${((d + 360) / 1080) * 100}%`;
    if (h % 90 === 0) ticks += `<b class="cp__major" style="${pos}">${LETTERS[h]}</b>`;
    else if (h % 45 === 0) ticks += `<b style="${pos}">${LETTERS[h]}</b>`;
    else ticks += `<i style="${pos}"></i>`;
  }
  el.innerHTML = `<div class="cp__tape">${ticks}</div><div class="cp__mid"></div><div class="cp__wp"><em></em><span></span></div>`;
  if (hidden) el.classList.add('hidden');
  document.body.appendChild(el);
  const tape = el.querySelector<HTMLElement>('.cp__tape')!, wp = el.querySelector<HTMLElement>('.cp__wp')!;
  const label = wp.querySelector('span')!;
  const dir = new THREE.Vector3();
  let lastText = '';

  return {
    update(camera: THREE.PerspectiveCamera, walking: boolean): void {
      el.classList.toggle('cp--fly', !walking);
      if (!walking || el.classList.contains('hidden')) return;
      const width = el.clientWidth, perDeg = width / SPAN;
      camera.getWorldDirection(dir);
      const heading = THREE.MathUtils.radToDeg(Math.atan2(dir.x, -dir.z));
      // (the tape is 1080 degrees wide: its own width in px is set here so the degrees stay matched to the strip)
      tape.style.width = `${1080 * perDeg}px`;
      tape.style.transform = `translateX(${width / 2 - (heading + 360) * perDeg}px)`;
      const dx = target.x - camera.position.x, dz = target.z - camera.position.z;
      const rel = THREE.MathUtils.euclideanModulo(THREE.MathUtils.radToDeg(Math.atan2(dx, -dz)) - heading + 180, 360) - 180;
      const edge = SPAN / 2 - 30, // (inside the strip's faded ends)
      clamped = THREE.MathUtils.clamp(rel, -edge, edge);
      wp.style.transform = `translateX(${width / 2 + clamped * perDeg}px)`;
      wp.classList.toggle('cp__wp--left', rel < -edge);
      wp.classList.toggle('cp__wp--right', rel > edge);
      const dist = Math.hypot(dx, dz);
      wp.style.opacity = String(THREE.MathUtils.clamp((dist - 10) / 10, 0, 1)); // (gone on arrival, like the marker)
      const text = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`;
      if (text !== lastText) label.textContent = lastText = text;
    },
  };
}
