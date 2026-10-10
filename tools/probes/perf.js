// Performance panel (src/perf-panel.ts; run with --query=perf=1): runs frames so the 15 s window fills a little,
// then returns the report text the panel copies on a click, and whether the panel is on screen.
async (demo) => {
  const panel = document.querySelector('.perf');
  if (!panel) return { error: 'no panel (use --query=perf=1)' };
  const t0 = performance.now();
  while (performance.now() - t0 < 3500) await demo.renderOnce(); // (past the 2 s warm-up)
  // (renderOnce doesn't run the page's loop: feed the panel the frames it would have seen)
  for (let i = 0, t = performance.now(); i < 120; i++) demo.hud?.perf?.frame(t + i * 16.7);
  const r = panel.getBoundingClientRect();
  return { visible: r.width > 0 && r.height > 0, rect: [r.x, r.y, r.width, r.height].map(Math.round), report: demo.perfReport() };
}
