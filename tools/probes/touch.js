// Touch controls (src/touch.ts; run with --query=touch=1): synthetic finger events on the canvas and the buttons,
// then how far the camera moved / turned / climbed. Left thumb pushed up = forward, right thumb dragged = look,
// the up button = climb. Each should be clearly non-zero; `stuck` lists what didn't respond.
async (demo) => {
  const canvas = demo.renderer.domElement;
  const cam = demo.camera, c = demo.controls;
  const ev = (target, type, id, x, y) =>
    target.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: id === 1 }));
  const frames = async (n) => { for (let i = 0; i < n; i++) await demo.renderOnce(); };
  if (!document.body.classList.contains('touch')) return { error: 'touch controls are off (use --query=touch=1)' };
  const fwd = cam.position.clone();
  cam.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize();
  c.velocity.set(0, 0, 0);

  // left thumb: push the stick fully up
  const W = innerWidth, H = innerHeight;
  const p0 = cam.position.clone();
  ev(canvas, 'pointerdown', 1, W * 0.2, H * 0.7);
  ev(canvas, 'pointermove', 1, W * 0.2, H * 0.7 - 80);
  await frames(20);
  const forward = cam.position.clone().sub(p0).dot(fwd);
  ev(canvas, 'pointerup', 1, W * 0.2, H * 0.7 - 80);
  await frames(20);
  const p1 = cam.position.clone();
  await frames(10);
  const drift = cam.position.distanceTo(p1); // (after letting go: should stop)

  // right thumb: drag 100 px to the right (yaw decreases)
  const yaw0 = c.yaw, pitch0 = c.pitch;
  ev(canvas, 'pointerdown', 2, W * 0.75, H * 0.5);
  ev(canvas, 'pointermove', 2, W * 0.75 + 100, H * 0.5 - 40);
  ev(canvas, 'pointerup', 2, W * 0.75 + 100, H * 0.5 - 40);
  const yaw = c.yaw - yaw0, pitch = c.pitch - pitch0;

  // up button: hold
  const up = document.querySelector('.touch-btn[title=up]');
  const y0 = cam.position.y;
  ev(up, 'pointerdown', 3, 0, 0);
  await frames(20);
  ev(up, 'pointerup', 3, 0, 0);
  const climb = cam.position.y - y0;

  // zoom button: hold
  const zoomBtn = document.querySelector('.touch-btn[title=zoom]');
  ev(zoomBtn, 'pointerdown', 4, 0, 0);
  await frames(30);
  const zoom = c.zoom;
  ev(zoomBtn, 'pointerup', 4, 0, 0);
  await frames(30);

  const r = { forward: +forward.toFixed(2), drift: +drift.toFixed(3), yaw: +yaw.toFixed(3), pitch: +pitch.toFixed(3), climb: +climb.toFixed(2), zoom: +zoom.toFixed(2), zoomBack: +c.zoom.toFixed(2) };
  r.stuck = [forward > 0.5 || 'stick', drift < 0.05 || 'stick release', yaw < -0.1 || 'look yaw', pitch > 0.05 || 'look pitch', climb > 0.5 || 'up button', zoom > 3 || 'zoom', c.zoom < 1.5 || 'zoom release'].filter((x) => x !== true);
  return r;
}
