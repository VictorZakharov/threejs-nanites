// What the harness is doing right now, for the watchdog in harness.mjs: a run that overruns --timeout reports the
// step it was stuck in instead of hanging silently.
export const status = { step: 'starting' };

/** Records the current step (e.g. "view ground: benchmark"). */
export const at = (step) => {
  status.step = step;
};
