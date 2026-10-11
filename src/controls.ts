import * as THREE from 'three/webgpu';

// Free-fly camera: click to capture the mouse, WASD move, Space up, Ctrl down, Shift faster. Holding the right mouse
// button zooms in 5x (binoculars).
// Fullscreen is the browser's (F11) or the settings menu's button, as in last-stand: a click only captures the mouse,
// and Esc releases it (the settings menu opens) and leaves fullscreen. It used to go fullscreen on every capture, take
// F11 over and lock the keyboard (Esc opened the menu inside fullscreen): leaving fullscreen took two presses (the
// menu's Resume went straight back in), and screenshots of the fullscreen window sometimes didn't work (the user).
// Ctrl+W can't be blocked by a page: a "leave site?" prompt guards it.

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
  // Walking: on the ground you walk at eye height with gravity; Space jumps, Space again in the air takes off into
  // flight, and flying down onto the ground lands you walking again (the user). Off under the harness (its views
  // are placed in the air). `groundAt`: the terrain height at (x, z).
  groundAt: ((x: number, z: number) => number) | null = null;
  walkEnabled = true;
  walking = false;
  eye = 1.7; // m
  walkSpeed = 4.2; // m/s (Shift runs: x2.2)
  vy = 0; // vertical speed while walking (m/s)
  jumped = false; // in the air from a jump: Space again flies
  wasJump = false;
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
      // swallow browser shortcuts (Ctrl+S/D/F...) while flying (not F11: the browser's fullscreen)
      if ((this.locked || e.ctrlKey) && e.code !== 'F11') e.preventDefault();
      if (!e.repeat) this.onKey?.(e.code, e);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('beforeunload', (e) => {
      // guard for Ctrl+W (a page can't block it)
      if (this.guardUnload) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    this.guardUnload = !new URLSearchParams(location.search).has('harness');
  }

  async capture(): Promise<void> {
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

  /** Gives the mouse back (the settings menu opens with Esc while flying). */
  release(): void {
    if (this.locked) document.exitPointerLock();
  }

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      /* refused */
    }
  }

  update(dt: number): void {
    const k = this.keys;
    const jumpHeld = k.has('Space') || this.analog.y > 0.5;
    const jump = jumpHeld && !this.wasJump; // (pressed this frame)
    this.wasJump = jumpHeld;
    if (this.walking && this.groundAt) this.walk(dt, jump);
    else this.fly(dt);
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

  /** On foot: WASD over the ground, gravity, Space jumps; Space again in the air takes off. */
  walk(dt: number, jump: boolean): void {
    const k = this.keys, p = this.camera.position;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (k.has('KeyW')) wish.add(fwd);
    if (k.has('KeyS')) wish.sub(fwd);
    if (k.has('KeyD')) wish.add(right);
    if (k.has('KeyA')) wish.sub(right);
    wish.addScaledVector(fwd, this.analog.z).addScaledVector(right, this.analog.x);
    if (wish.lengthSq() > 1) wish.normalize();
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    wish.multiplyScalar(this.walkSpeed * (fast ? 2.2 : 1));
    this.velocity.x += (wish.x - this.velocity.x) * (1 - Math.exp(-dt * 12));
    this.velocity.z += (wish.z - this.velocity.z) * (1 - Math.exp(-dt * 12));
    const ground = this.groundAt!(p.x, p.z) + this.eye;
    const onGround = p.y <= ground + 0.05 && this.vy <= 0;
    if (onGround) {
      this.jumped = false;
      this.vy = jump ? 6.5 : 0;
      if (jump) this.jumped = true;
    } else if (jump && this.jumped) {
      // double jump: fly
      this.walking = false;
      this.velocity.y = 8;
      this.held = 0;
      return;
    }
    this.vy -= 22 * dt;
    p.x += this.velocity.x * dt;
    p.z += this.velocity.z * dt;
    p.y += this.vy * dt;
    const g = this.groundAt!(p.x, p.z) + this.eye;
    // land, and keep to the ground walking downhill (no hops off every slope)
    if (p.y < g || (onGround && !jump && p.y - g < 0.5)) {
      p.y = g;
      this.vy = 0;
    }
    this.velocity.y = 0;
  }

  /** Free flight; touching the ground lands you walking. */
  fly(dt: number): void {
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
    const p = this.camera.position;
    p.addScaledVector(this.velocity, dt);
    if (this.walkEnabled && this.groundAt && this.velocity.y <= 0.5 && !k.has('Space') && this.analog.y <= 0) {
      const g = this.groundAt(p.x, p.z) + this.eye;
      if (p.y <= g) {
        p.y = g;
        this.walking = true;
        this.vy = 0;
        this.velocity.y = 0;
      }
    }
  }
}
