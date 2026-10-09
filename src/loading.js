// Startup screen: progress bar, status line, timestamped log, error panel (after the cape-physics demo's).
const t0 = performance.now();

export class LoadingScreen {
  constructor() {
    this.root = document.querySelector('[data-loading]');
    this.bar = this.root.querySelector('[data-loading-bar]');
    this.status = this.root.querySelector('[data-loading-status]');
    this.progress = this.root.querySelector('[data-loading-progress]');
    this.log = this.root.querySelector('[data-loading-log]');
    this.errorPanel = this.root.querySelector('[data-loading-error]');
    this.errorDetail = this.root.querySelector('[data-loading-error-detail]');
    this.estimate = null;
    this.value = 0;
  }

  /** Logs a line without moving the bar. */
  note(message) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = `${((performance.now() - t0) / 1000).toFixed(2)}s`;
    const span = document.createElement('span');
    span.textContent = message;
    li.append(time, span);
    this.log.append(li);
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Moves the bar to `progress` (0..1), sets the status, logs it, and lets the browser paint. */
  async update(progress, message, log = true) {
    this._cancelEstimate();
    this.value = Math.max(this.value, Math.min(1, progress));
    const pct = Math.round(this.value * 100);
    this.bar.style.transitionDuration = '450ms';
    this.bar.style.transitionTimingFunction = 'ease';
    this.bar.style.width = `${pct}%`;
    this.status.textContent = message;
    this.progress.textContent = `${pct}%`;
    if (log) this.note(message);
    await nextPaint();
  }

  /**
   * Before a long synchronous stage (shader compilation) the bar keeps easing towards `anticipated` on the
   * compositor, so it doesn't look frozen while the main thread is busy.
   */
  async beginLongStage(progress, anticipated, message, ms = 4000) {
    await this.update(progress, message);
    const start = this.value, end = Math.max(start, anticipated), began = performance.now();
    this.bar.style.transitionDuration = `${ms}ms`;
    this.bar.style.transitionTimingFunction = 'cubic-bezier(0.16, 0.72, 0.25, 1)';
    this.bar.style.width = `${(end * 100).toFixed(1)}%`;
    const tick = (now) => {
      const k = Math.min(1, (now - began) / ms);
      this.progress.textContent = `${((start + (end - start) * (1 - (1 - k) ** 3)) * 100).toFixed(1)}%`;
      this.estimate = k < 1 ? requestAnimationFrame(tick) : null;
    };
    this.estimate = requestAnimationFrame(tick);
    await nextPaint();
  }

  async reveal() {
    await this.update(1, 'Enter the forest');
    document.body.classList.add('is-ready');
  }

  fail(error) {
    this._cancelEstimate();
    const message = error?.message ?? String(error);
    this.root.classList.add('has-error');
    this.status.textContent = 'Startup failed';
    this.progress.textContent = 'FAILED';
    this.note(`FAILED · ${message}`);
    this.errorDetail.textContent = message;
    this.errorPanel.hidden = false;
  }

  _cancelEstimate() {
    if (this.estimate !== null) cancelAnimationFrame(this.estimate);
    this.estimate = null;
  }
}

function nextPaint() {
  // two frames: the first lets style/layout apply, the second is after the paint
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
