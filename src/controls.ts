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
/** The Keyboard Lock API (Chrome/Edge; not in TypeScript's DOM types yet). */
const keyboard = (navigator as Navigator & { keyboard?: { lock?(codes: string[]): Promise<void> } }).keyboard;

export class FlyControls {
  readonly camera: THREE.PerspectiveCamera;
  readonly dom: HTMLElement;
  yaw = 0;
  pitch = 0;
  speed = 12;
  fastMul = 4; // Shift
  // holding a movement key builds speed: x(1 + (t/rampTime)^2), capped
  rampTime = 1.6;
  maxRamp = 40;
  maxSpeed = 900; // m/s
  held = 0;
  readonly keys = new Set<string>();
  readonly analog = new THREE.Vector3(); // touch input (src/touch.ts): x strafe, y up/down, z forward, each -1..1
  readonly velocity = new THREE.Vector3();
  locked = false;
  onKey: ((code: string, event: KeyboardEvent) => void) | null = null; // app shortcuts
  onUnlock: (() => void) | null = null; // the mouse was released (Esc): the settings menu opens
  readonly baseFov: number;
  zoom = 1;
  zoomTarget = 1;
  zoomMax = 5;
  touchMode = false; // (src/touch.ts: no pointer lock on a tap)
  guardUnload: boolean;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    this.dom = dom;
    this.baseFov = camera.fov;
    dom.addEventListener('click', () => this.touchMode || this.capture());
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === dom;
      if (!this.locked) {
        if (was) this.onUnlock?.();
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

  async capture(): Promise<void> {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch {
      /* fullscreen refused: still fine */
    }
    try {
      // in fullscreen this captures Ctrl+W, Ctrl+T, Esc-hold etc.
      await keyboard?.lock?.(LOCKED_KEYS);
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

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        await keyboard?.lock?.(LOCKED_KEYS);
      }
    } catch {
      /* refused */
    }
  }

  update(dt: number): void {
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
