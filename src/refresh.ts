// The display's refresh rate, from the browser's own frames. It starts with the module, during the loading: the main
// thread is mostly free then (the work is in workers), so frames come at the display's rate. Later, a GPU that can't keep
// up would read as a slower display (the performance panel's "display ~100 Hz" on a 144 Hz screen), so the highest rate
// seen stays. Its use: auto quality's budget (a 60 Hz laptop was held to 144 Hz's 5.5 ms, and could never get under it).
const RATES = [30, 60, 75, 90, 100, 120, 144, 165, 240];
const WINDOW = 60; // frames

let hz = 60, last = 0;
const dts: number[] = [];
function tick(now: number): void {
  if (last && now - last < 200) dts.push(now - last); // (not a hidden tab's gap)
  last = now;
  if (dts.length >= WINDOW) {
    const fast = [...dts].sort((a, b) => a - b)[WINDOW >> 3]; // (past the odd double-fired frame)
    const rate = RATES.reduce((a, b) => (Math.abs(b - 1000 / fast) < Math.abs(a - 1000 / fast) ? b : a));
    if (rate > hz) hz = rate;
    dts.length = 0;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/** The highest refresh rate seen so far (Hz; 60 until something faster is). */
export const refreshRate = (): number => hz;

/**
 * Auto quality's GPU budget (ms): 80% of the display's frame, the rest for the CPU and the compositor, and never under
 * 144 Hz's 5.5 (what the desktops were tuned to: a 240 Hz screen shouldn't blur the image for frames it can't get anyway).
 */
export const budgetFor = (rate: number): number => Math.max(5.5, (1000 / rate) * 0.8);
