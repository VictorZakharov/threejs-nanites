import * as THREE from 'three/webgpu';

// Free-fly camera: click to capture the mouse, WASD move, Space up, Ctrl down, Shift faster.
// Ctrl+W can't be blocked by a normal page (the browser reserves it). In fullscreen the Keyboard Lock API
// (Chrome/Edge) captures the flight keys - Ctrl+W included - and elsewhere a "leave site?" prompt is the fallback.
// Esc is deliberately *not* locked: one press leaves the mouse/fullscreen (a locked Esc must be held for 2 s).
// F11 toggles fullscreen. Holding the right mouse button zooms in 5x (binoculars).
const LOCKED_KEYS = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyL', 'KeyP', 'KeyN', 'KeyT', 'KeyR',
  'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'Tab', 'BracketLeft', 'BracketRight',
  'Minus', 'Equal', 'F11',
];
export class FlyControls {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.yaw = 0;
    this.pitch = 0;
    this.speed = 12;
    this.fastMul = 4; // Shift
    // holding a movement key builds speed: x(1 + (t/rampTime)^2), capped
    this.rampTime = 1.6;
    this.maxRamp = 40;
    this.maxSpeed = 900; // m/s
    this.held = 0;
    this.keys = new Set();
    this.analog = new THREE.Vector3(); // touch input (src/touch.js): x strafe, y up/down, z forward, each -1..1
    this.velocity = new THREE.Vector3();
    this.locked = false;
    this.onKey = null; // (code, event) for app shortcuts
    this.baseFov = camera.fov;
    this.zoom = 1;
    this.zoomTarget = 1;
    this.zoomMax = 5;

    this.touchMode = false; // (src/touch.js: no pointer lock on a tap)
    dom.addEventListener('click', () => this.touchMode || this.capture());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      if (!this.locked) {
        this.keys.clear();
        this.zoomTarget = 1;
      }
      document.body.classList.toggle('captured', this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const sens = 0.0022 / this.zoom; // finer aim while zoomed
      this.yaw -= e.movementX * sens;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * sens, -1.55, 1.55);
    });
    document.addEventListener('mousedown', (e) => {
      if (e.button === 2 && this.locked) this.zoomTarget = this.zoomMax;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.zoomTarget = 1;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F11') {
        e.preventDefault();
        this.toggleFullscreen();
        return;
      }
      // swallow browser shortcuts (Ctrl+S/D/F...) while flying; Ctrl+W needs the keyboard lock below
      if (this.locked || e.ctrlKey) e.preventDefault();
      if (!e.repeat) this.onKey?.(e.code, e);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('beforeunload', (e) => {
      // fallback guard for Ctrl+W when the keyboard isn't locked
      if (this.guardUnload) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    this.guardUnload = !new URLSearchParams(location.search).has('harness');
  }

  async capture() {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch {
      /* fullscreen refused: still fine */
    }
    try {
      // in fullscreen this captures Ctrl+W, Ctrl+T, Esc-hold etc.
      await navigator.keyboard?.lock?.(LOCKED_KEYS);
    } catch {
      /* not supported */
    }
    try {
      await this.dom.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try {
        await this.dom.requestPointerLock();
      } catch {
        /* ignore */
      }
    }
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        await navigator.keyboard?.lock?.(LOCKED_KEYS);
      }
    } catch {
      /* refused */
    }
  }

  update(dt) {
    const k = this.keys;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (k.has('KeyW')) wish.add(fwd);
    if (k.has('KeyS')) wish.sub(fwd);
    if (k.has('KeyD')) wish.add(right);
    if (k.has('KeyA')) wish.sub(right);
    if (k.has('Space')) wish.y += 1;
    if (k.has('ControlLeft') || k.has('ControlRight')) wish.y -= 1;
    if (wish.lengthSq() > 0) wish.normalize();
    // (the touch stick: how far it's pushed sets the speed share)
    const a = this.analog;
    wish.addScaledVector(fwd, a.z).addScaledVector(right, a.x);
    wish.y += a.y;
    if (wish.lengthSq() > 1) wish.normalize();
    const moving = wish.lengthSq() > 1e-4;
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    // the longer you hold, the faster (Shift ramps up quicker too); letting go resets
    this.held = moving ? this.held + dt * (fast ? 1.6 : 1) : 0;
    const ramp = Math.min(this.maxRamp, 1 + (this.held / this.rampTime) ** 2);
    wish.multiplyScalar(Math.min(this.maxSpeed, this.speed * ramp * (fast ? this.fastMul : 1)));
    // smooth acceleration
    this.velocity.lerp(wish, 1 - Math.exp(-dt * 10));
    this.camera.position.addScaledVector(this.velocity, dt);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    // zoom: narrow the field of view (the LOD reads camera.fov, so zoomed trees get their detail back)
    this.zoom += (this.zoomTarget - this.zoom) * (1 - Math.exp(-dt * 12));
    if (Math.abs(this.zoom - this.zoomTarget) < 1e-3) this.zoom = this.zoomTarget;
    this.camera.userData.zoom = this.zoom;
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.baseFov) / 2) / this.zoom));
    if (Math.abs(fov - this.camera.fov) > 1e-6) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
