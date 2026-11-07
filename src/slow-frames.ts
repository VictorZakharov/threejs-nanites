// Why frames were slow, for the copied report (the user on the AMD PC: "turning lags", 44 fps with a 16.7 ms median, while
// the harness's turning held 60 there with no frame over 25 ms: the cause had to come from the device's own report).
// Each display frame over SLOW_MS (from one animation frame to the next) is put down to what the last one did: skipped
// for the GPU queue (?gpuqueue=: frames still on the GPU), long on the main thread (the loop's own JavaScript), or neither
// (the browser: input, compositing, other tabs). Kept over the panel's window.
const SLOW_MS = 25, KEEP_MS = 15000;

interface Slow {
  at: number; // ms (performance.now())
  ms: number; // since the frame before
  cause: 'gpu queue' | 'main thread' | 'browser';
  js: number; // the loop's own ms in the frame before
  queue: number; // the last submit-to-done ms
}

export interface SlowFrames {
  /** Call at the top of every animation frame (`skipped`: this one is skipped for the GPU queue). */
  begin(now: number, skipped: boolean, queueMs: number): void;
  /** Call when the frame's own work is done. */
  end(now: number): void;
  report(): string;
}

export function createSlowFrames(): SlowFrames {
  const log: Slow[] = [];
  let prev = 0, js = 0, start = 0, lastSkipped = false, frames: number[] = [];
  return {
    begin(now, skipped, queueMs) {
      if (prev) {
        const ms = now - prev;
        frames.push(now);
        if (ms > SLOW_MS) log.push({ at: now, ms, cause: lastSkipped ? 'gpu queue' : js > SLOW_MS * 0.6 ? 'main thread' : 'browser', js, queue: queueMs });
      }
      while (log.length && now - log[0].at > KEEP_MS) log.shift();
      frames = frames.filter((t) => now - t <= KEEP_MS);
      prev = now;
      start = now;
      lastSkipped = skipped;
      if (skipped) js = 0;
    },
    end(now) {
      js = now - start;
    },
    report() {
      if (!log.length) return `slow frames  none over ${SLOW_MS} ms of ${frames.length}`;
      const by = (c: Slow['cause']): Slow[] => log.filter((s) => s.cause === c);
      const med = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
      const line = (c: Slow['cause']): string => {
        const s = by(c);
        return s.length ? `  ${c.padEnd(12)} ${s.length}, median ${med(s.map((x) => x.ms)).toFixed(1)} ms, main thread ${med(s.map((x) => x.js)).toFixed(1)} ms, gpu queue ${med(s.map((x) => x.queue)).toFixed(1)} ms` : '';
      };
      const worst = [...log].sort((a, b) => b.ms - a.ms).slice(0, 5)
        .map((s) => `  ${s.ms.toFixed(1)} ms: ${s.cause}, main thread ${s.js.toFixed(1)}, gpu queue ${s.queue.toFixed(1)}`);
      return [`slow frames  ${log.length} over ${SLOW_MS} ms of ${frames.length} in the last ${KEEP_MS / 1000} s, by cause:`,
        ...(['gpu queue', 'main thread', 'browser'] as const).map(line).filter(Boolean), ' worst', ...worst].join('\n');
    },
  };
}
