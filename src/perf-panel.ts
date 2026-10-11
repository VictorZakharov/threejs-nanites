// Performance panel (after the one in cape-physics): average FPS and 1% low over the last 15 s with a history graph,
// frame time and its p95, the GPU time split into draw and compute against the auto-quality budget, the resolution
// and the quality. A click (or tap) copies a plain-text report with everything needed to compare devices: the
// numbers, the scene counters, the camera, the adapter and the URL.

const WINDOW_MS = 15000;
const MAX_SAMPLES = 8192;
const HISTORY = 78; // graph points (one per repaint, 4 per second)
const WARMUP_MS = 2000; // after start and after the tab comes back: compiles and catch-up frames aren't the steady state

const fmt = (v: number, d = 2): string => (v > 0 ? v.toFixed(d) : '--');
const count = (v: number): string => Math.round(v).toLocaleString('en-US');
/** A count in a few characters: 1,440 / 123 k / 1.62 M (in millions with two decimals, small counts read as 0.00). */
export const short = (v: number): string =>
  v < 1e4 ? count(v) : v < 1e6 ? `${+(v / 1e3).toFixed(v < 1e5 ? 1 : 0)} k` : `${(v / 1e6).toFixed(2)} M`;

/** What the panel shows besides the frame times (src/hud.ts fills it in). */
export interface PerfDetails {
  gpu: { render: number; compute: number; total: number; budget: number };
  quality: { tau: number; auto: boolean; scale: number; limited: boolean; shadows: boolean };
  resolution: { width: number; height: number; pixelRatio: number; msaa: number; taa: boolean };
  scene: {
    trees: number; total: number; bushes: number; statues: number; impostors: number; clusters: number; swClusters: number;
    tris: number; swTris: number; impostorTris: number; shadowTris: number;
  } | null;
  camera: { x: number; z: number; agl: number; zoom: number; yaw: number; pitch: number };
  adapter: string;
}

/** Frame statistics over the window. */
interface FrameStats {
  samples: number;
  seconds: number;
  avgFps: number;
  lowFps: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  longest: number;
  long: number;
  refresh: number;
}

type Label = 'fps' | 'caption' | 'rate' | 'frame' | 'gpu' | 'res' | 'quality' | 'scene' | 'hw' | 'copy';

export class PerfPanel {
  readonly details: () => PerfDetails;
  readonly times = new Float64Array(MAX_SAMPLES);
  readonly durations = new Float64Array(MAX_SAMPLES);
  start = 0;
  n = 0;
  last: number | null = null;
  lastPaint = 0;
  warmUntil = performance.now() + WARMUP_MS;
  readonly avgHistory: number[] = [];
  readonly lowHistory: number[] = [];
  snap: FrameStats | null = null;
  readonly el: HTMLButtonElement;
  readonly k: Record<Label, HTMLElement>;
  readonly paths: { avg: SVGPathElement; low: SVGPathElement };
  copyTimer = 0;
  profileText = ''; // the last GPU profile (src/profile.ts, from the settings menu), appended to the report

  constructor(details: () => PerfDetails) {
    this.details = details;
    const el = (this.el = document.createElement('button'));
    el.type = 'button';
    el.className = 'perf';
    el.title = 'Click to copy a 15-second performance report';
    el.innerHTML = `
      <strong><b data-k="fps">--</b><i> FPS AVG</i></strong>
      <span data-k="caption">DISPLAY FPS / LAST 15S</span>
      <svg viewBox="0 0 154 32" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="1" x2="154" y2="1"></line><line x1="0" y1="16" x2="154" y2="16"></line>
        <path class="avg" d=""></path><path class="low" d=""></path>
      </svg>
      <small data-k="rate"></small><small data-k="frame"></small><small data-k="gpu"></small>
      <small data-k="res"></small><small data-k="quality"></small><small data-k="scene"></small>
      <small class="perf__hw" data-k="hw"></small>
      <span class="perf__copy" data-k="copy">CLICK TO COPY 15S REPORT</span>`;
    this.k = Object.fromEntries([...el.querySelectorAll<HTMLElement>('[data-k]')].map((e) => [e.dataset.k, e])) as Record<Label, HTMLElement>;
    this.paths = { avg: el.querySelector<SVGPathElement>('.avg')!, low: el.querySelector<SVGPathElement>('.low')! };
    // (pointerdown would also start a look drag on the canvas: the panel sits above it and takes the event)
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.copy();
    });
    (document.getElementById('corner') ?? document.body).prepend(el);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.restart();
    });
  }

  /** Drops the samples (a resize, the tab coming back): the next 2 s aren't counted. */
  restart(): void {
    this.start = this.n = 0;
    this.last = null;
    this.warmUntil = performance.now() + WARMUP_MS;
  }

  /** Once per displayed frame. */
  frame(now = performance.now()): void {
    if (now < this.warmUntil) {
      this.last = null;
    } else if (this.last === null) {
      this.last = now;
    } else {
      const d = now - this.last;
      this.last = now;
      if (d > 0) {
        const i = (this.start + this.n) % MAX_SAMPLES;
        this.times[i] = now;
        this.durations[i] = d;
        if (this.n < MAX_SAMPLES) this.n++;
        else this.start = (this.start + 1) % MAX_SAMPLES;
        while (this.n > 0 && this.times[this.start] < now - WINDOW_MS) {
          this.start = (this.start + 1) % MAX_SAMPLES;
          this.n--;
        }
      }
    }
    if (now - this.lastPaint >= 250) {
      this.lastPaint = now;
      this.snap = this.measure();
      this.paint(now < this.warmUntil);
    }
  }

  /** Frame statistics over the window. */
  measure(): FrameStats {
    const d: number[] = [];
    for (let k = 0; k < this.n; k++) d.push(this.durations[(this.start + k) % MAX_SAMPLES]);
    d.sort((a, b) => a - b);
    const pct = (r: number): number => (d.length ? d[Math.min(d.length - 1, Math.floor(r * d.length))] : 0);
    const total = d.reduce((a, b) => a + b, 0);
    const avgMs = d.length ? total / d.length : 0;
    // 1% low: the rate of the average of the slowest 1% of frames (not the p99 sample)
    const slow = Math.max(1, Math.ceil(d.length * 0.01));
    const slowMs = d.slice(-slow).reduce((a, b) => a + b, 0) / slow;
    const fast = pct(0.1);
    const raw = fast > 0 ? 1000 / fast : 60;
    const refresh = [30, 60, 75, 90, 100, 120, 144, 165, 240].reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a), 60);
    return {
      samples: d.length,
      seconds: d.length ? Math.min(WINDOW_MS, total) / 1000 : 0,
      avgFps: avgMs > 0 ? 1000 / avgMs : 0,
      lowFps: slowMs > 0 ? 1000 / slowMs : 0,
      avgMs,
      medianMs: pct(0.5),
      p95Ms: pct(0.95),
      p99Ms: pct(0.99),
      longest: d.length ? d[d.length - 1] : 0,
      long: d.filter((x) => x >= 50).length,
      refresh,
    };
  }

  paint(warming: boolean): void {
    if (!this.snap) return;
    const s = this.snap, det = this.details(), g = det.gpu;
    this.el.classList.toggle('is-warming', warming);
    const capped = s.samples >= 30 && s.avgFps >= s.refresh * 0.97;
    this.k.caption.textContent = warming ? 'WARMING UP / STATS PAUSED' : capped ? 'DISPLAY FPS / VSYNC-CAPPED' : 'DISPLAY FPS / LAST 15S';
    this.k.fps.textContent = fmt(s.avgFps);
    this.k.rate.innerHTML = `<b>${fmt(s.avgFps, 1)}</b> AVG / <b>${fmt(s.lowFps, 1)}</b> 1% LOW`;
    this.k.frame.innerHTML = `<b>${fmt(s.avgMs)}</b> MS FRAME / <b>${fmt(s.p95Ms)}</b> P95`;
    this.k.gpu.innerHTML = g.total > 0
      ? `<b>${fmt(g.total)}</b> MS GPU (<b>${fmt(g.render, 1)}</b> DRAW + <b>${fmt(g.compute, 1)}</b> CULL) / <b>${g.budget}</b> BUDGET`
      : 'GPU TIME UNAVAILABLE';
    const r = det.resolution;
    this.k.res.innerHTML = `<b>${r.width}×${r.height}</b> @ <b>${r.pixelRatio.toFixed(2)}</b> · ${r.msaa}× MSAA · TAA ${r.taa ? 'ON' : 'OFF'}`;
    this.k.quality.innerHTML = `ERROR <b>${det.quality.tau.toFixed(2)}</b> PX ${det.quality.auto ? '(AUTO)' : '(MANUAL)'}${det.quality.scale < 1 ? ` · RES <b>${Math.round(det.quality.scale * 100)}</b>%` : ''}${det.quality.limited ? ' · AT LIMIT' : ''}`;
    const sc = det.scene;
    this.k.scene.innerHTML = sc
      ? `<b>${count(sc.trees)}</b> PLANTS · <b>${short(sc.tris + sc.swTris + sc.impostorTris)}</b> TRIS · SHADOW <b>${short(sc.shadowTris)}</b>`
      : '';
    this.k.hw.textContent = det.adapter;
    this.el.classList.toggle('has-drop', s.avgFps > 0 && s.avgFps < Math.min(52, s.refresh * 0.78));
    if (warming) return;
    this.avgHistory.push(s.avgFps);
    this.lowHistory.push(s.lowFps);
    if (this.avgHistory.length > HISTORY) this.avgHistory.shift(), this.lowHistory.shift();
    const lo = s.refresh * 0.25, hi = s.refresh * 1.02;
    const path = (h: number[]): string => h.map((v, i) => {
      const x = h.length <= 1 ? 0 : (i / (h.length - 1)) * 154;
      const y = (1 - Math.max(0, Math.min(1, (v - lo) / (hi - lo)))) * 31;
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    this.paths.avg.setAttribute('d', path(this.avgHistory));
    this.paths.low.setAttribute('d', path(this.lowHistory));
  }

  /** The plain-text report the panel copies. */
  report(): string {
    const s = this.measure(), det = this.details(), g = det.gpu, r = det.resolution, sc = det.scene ?? { trees: 0, total: 0, bushes: 0, statues: 0, impostors: 0, clusters: 0, swClusters: 0, tris: 0, swTris: 0, impostorTris: 0, shadowTris: 0 }, c = det.camera;
    const lines = [
      `Nanite Forest performance report, ${new Date().toISOString()}`,
      `url          ${location.href}`,
      `browser      ${navigator.userAgent}`,
      `adapter      ${det.adapter}`,
      `screen       ${r.width}x${r.height} drawing buffer, ${innerWidth}x${innerHeight} css, pixel ratio ${r.pixelRatio} (device ${devicePixelRatio}), ${r.msaa}x MSAA, TAA ${r.taa ? 'on' : 'off'}`,
      '',
      `window       ${s.seconds.toFixed(1)} s, ${s.samples} frames, display ~${s.refresh} Hz`,
      `fps          ${fmt(s.avgFps)} avg, ${fmt(s.lowFps)} 1% low`,
      `frame ms     ${fmt(s.avgMs)} avg, ${fmt(s.medianMs)} median, ${fmt(s.p95Ms)} p95, ${fmt(s.p99Ms)} p99, ${fmt(s.longest)} longest, ${s.long} over 50 ms`,
      `gpu ms       ${g.total > 0 ? `${fmt(g.total)} total = ${fmt(g.render)} render passes + ${fmt(g.compute)} compute passes` : 'unavailable (no timestamp queries)'}, budget ${g.budget}`,
      `quality      error ${det.quality.tau.toFixed(2)} px, resolution ${Math.round(det.quality.scale * 100)}%, ${det.quality.auto ? 'auto' : 'manual'}${det.quality.limited ? ' (at its limit)' : ''}, shadows ${det.quality.shadows ? 'on' : 'off'}`,
      '',
      `plants       ${count(sc.trees)} visible (${count(sc.impostors)} impostors) of ${count(sc.total)} trees + ${count(sc.bushes)} bushes + ${count(sc.statues)} statues`,
      `clusters     ${count(sc.clusters)} hardware, ${count(sc.swClusters)} software`,
      `triangles    ${count(sc.tris)} hardware, ${count(sc.swTris)} software, ${count(sc.impostorTris)} impostors (2 each), ${count(sc.shadowTris)} shadow casters (impostors' too)`,
      `camera       x ${c.x.toFixed(0)} z ${c.z.toFixed(0)}, ${c.agl.toFixed(0)} m above ground, yaw ${c.yaw.toFixed(1)} pitch ${c.pitch.toFixed(1)} deg, zoom ${c.zoom.toFixed(1)}x`,
    ];
    if (this.profileText) lines.push('', this.profileText);
    return lines.join('\n');
  }

  /** A status line in place of the copy hint (the profile's progress). */
  status(text: string): void {
    this.k.copy.textContent = text;
  }

  async copy(): Promise<void> {
    const label = this.k.copy;
    try {
      await copyText(this.report());
      this.el.dataset.copy = 'copied';
      label.textContent = 'COPIED 15S REPORT';
    } catch (err) {
      console.warn('Unable to copy the performance report.', err);
      this.el.dataset.copy = 'failed';
      label.textContent = 'COPY FAILED';
    }
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      delete this.el.dataset.copy;
      label.textContent = 'CLICK TO COPY 15S REPORT';
    }, 2000);
  }
}

/** navigator.clipboard where allowed, else the old textarea + execCommand route (plain http, older browsers). */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.readOnly = true;
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Clipboard copy was rejected.');
}
