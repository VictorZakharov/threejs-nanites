// Auto quality across the 5x zoom (src/auto-quality.ts): the real loop at the view, 4 s each unzoomed / zoomed /
// unzoomed / zoomed, against the desktop budget (`?autobudget=`, default the page's: 5.5 ms). Per phase: how long the
// GPU time took to get within 10% of the budget (-1: never), the frames over twice the budget, and tau/scale every
// 250 ms. Run it on a view whose zoom is costly (`canopyzoom` with `--zoom=1`), `--timeout=120`.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  const b = new URLSearchParams(location.search).get('autobudget');
  return demo.autoZoomTest(4000, b ? Number(b) : undefined);
}
