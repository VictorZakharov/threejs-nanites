// Startup screen: progress bar, status line, timestamped log, error panel (after the cape-physics demo's).
// (times are from the navigation's start, performance.now(): the download of the page and its script counts)

/** The element under `root` matching `selector` (the page's markup is fixed: missing means a broken page). */
function find<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Loading screen markup is missing ${selector}.`);
  return el;
}

export class LoadingScreen {
  readonly root: HTMLElement;
  readonly bar: HTMLElement;
  readonly status: HTMLElement;
  readonly progress: HTMLElement;
  readonly log: HTMLElement;
  readonly errorPanel: HTMLElement;
  readonly errorDetail: HTMLElement;
  readonly errorHint: HTMLElement;
  readonly continueButton: HTMLButtonElement;
  /** The log's lines with their times (ms since the navigation started): the harness's `--load` reads them. */
  readonly entries: { t: number; msg: string }[] = [];
  estimate: number | null = null;
  value = 0;

  constructor() {
    this.root = find(document, '[data-loading]');
    this.bar = find(this.root, '[data-loading-bar]');
    this.status = find(this.root, '[data-loading-status]');
    this.progress = find(this.root, '[data-loading-progress]');
    this.log = find(this.root, '[data-loading-log]');
    this.errorPanel = find(this.root, '[data-loading-error]');
    this.errorDetail = find(this.root, '[data-loading-error-detail]');
    this.errorHint = find(this.root, '[data-loading-error-hint]');
    this.continueButton = find<HTMLButtonElement>(this.root, '[data-loading-continue]');
  }

  /** Logs a line without moving the bar. */
  note(message: string): void {
    console.info(`[loading] ${message}`); // (the harness keeps the page console: boot breakdown)
    const now = performance.now();
    this.entries.push({ t: now, msg: message });
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = `${(now / 1000).toFixed(2)}s`;
    const span = document.createElement('span');
    span.textContent = message;
    li.append(time, span);
    this.log.append(li);
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Moves the bar to `progress` (0..1), sets the status, logs it, and lets the browser paint. */
  async update(progress: number, message: string, log = true): Promise<void> {
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
  async beginLongStage(progress: number, anticipated: number, message: string, ms = 4000): Promise<void> {
    await this.update(progress, message);
    const start = this.value, end = Math.max(start, anticipated), began = performance.now();
    this.bar.style.transitionDuration = `${ms}ms`;
    this.bar.style.transitionTimingFunction = 'cubic-bezier(0.16, 0.72, 0.25, 1)';
    this.bar.style.width = `${(end * 100).toFixed(1)}%`;
    const tick = (now: number): void => {
      const k = Math.min(1, (now - began) / ms);
      this.progress.textContent = `${((start + (end - start) * (1 - (1 - k) ** 3)) * 100).toFixed(1)}%`;
      this.estimate = k < 1 ? requestAnimationFrame(tick) : null;
    };
    this.estimate = requestAnimationFrame(tick);
    await nextPaint();
  }

  async reveal(): Promise<void> {
    await this.update(1, 'Enter the forest');
    document.body.classList.add('is-ready');
  }

  /** Shows the error panel; `hint` replaces its line under the message, `status` the status line's. */
  fail(error: unknown, hint?: string, status = 'Startup failed'): void {
    this._cancelEstimate();
    const message = error instanceof Error ? error.message : String(error);
    this.root.classList.add('has-error');
    this.status.textContent = status;
    this.progress.textContent = 'FAILED';
    if (hint) this.errorHint.textContent = hint;
    this.note(`FAILED · ${message}`);
    this.errorDetail.textContent = message;
    this.errorPanel.hidden = false;
  }

  /**
   * A warning in the error panel's place with a button (`label`); resolves when it's pressed (at once with `auto`),
   * and the screen goes on loading.
   */
  async ask(message: string, hint: string, label: string, auto = false): Promise<void> {
    this.root.classList.add('is-asking');
    this.status.textContent = 'No WebGPU';
    this.progress.textContent = '';
    this.note(message);
    this.errorDetail.textContent = message;
    this.errorHint.textContent = hint;
    this.continueButton.textContent = label;
    this.continueButton.hidden = false;
    this.errorPanel.hidden = false;
    if (!auto) await new Promise<void>((r) => this.continueButton.addEventListener('click', () => r(), { once: true }));
    this.root.classList.remove('is-asking');
    this.errorPanel.hidden = true;
    this.continueButton.hidden = true;
    this.note(`${label}`);
  }

  _cancelEstimate(): void {
    if (this.estimate !== null) cancelAnimationFrame(this.estimate);
    this.estimate = null;
  }
}

function nextPaint(): Promise<void> {
  // two frames: the first lets style/layout apply, the second is after the paint
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
