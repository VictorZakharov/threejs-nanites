// What each low-end tier of auto quality saves from submit to done (ms), learned as it steps: the GPU timers miss the browser's
// compositing of the canvas, a cost of its own rather than a share of the timers (as a ratio, 1.43 from 18.8 -> 13.1 ms, a
// cheap spot at tier 2 came back to 1 within 5 s). In Chrome on the AMD PC tier 2 -> 1 at 7.4 ms of timers took the frames
// from 12.6 ms submit to done to 27, every half a minute. Used by src/auto-quality.ts.

// (a saving halves in this long: at 3 min one learned at a costly spot had faded to 4 ms of the 13 tier 1 costs two minutes
// on, and tier 1 came back with frames waiting 26 ms)
const SAVES_HALF = 600000;
// (measured this long after the step: the tier's switches and the eased submit-to-done settle)
const SETTLE = 3000;

type TierStep = { tier: number; q: number; t: number };

export interface TierCosts {
  /** Before a tier change from `from` to `to`, with the latest submit-to-done `q`. */
  stepping(from: number, to: number, q: number): void;
  /**
   * Each timer sample: learns from a step SETTLE ms old. Returns true when a step down a tier filled the frame (over 95% of
   * `display` ms): it goes straight back up (the AMD PC came back to tier 1 with frames waiting 26-29 ms for 40 s).
   */
  sample(q: number, t: number, tier: number, display: number, log: (text: string) => void): boolean;
  /** The learned saving of the tier above `tier` (what coming back down to `tier` would add), ms. */
  saving(tier: number): number;
}

export function createTierCosts(): TierCosts {
  const saves: number[] = [];
  let at = 0, left: TierStep | null = null, down: TierStep | null = null;
  return {
    stepping(from, to, q) {
      if (!(q > 0)) return;
      if (to < from) down = { tier: to, q, t: performance.now() };
      // (two steps within the settling time, as when hurrying 1 -> 2 -> 3: the first tier is the one learned, by the whole
      // saving, so it can't come back on what the second saved)
      if (to > from) left = { tier: left?.tier ?? from, q: left?.q ?? q, t: performance.now() };
    },
    sample(q, t, tier, display, log) {
      let back = false;
      if (left && t - left.t > SETTLE) {
        if (q > 0) saves[left.tier] = Math.max(saves[left.tier] ?? 0, left.q - q);
        log(`tier ${left.tier} -> ${tier}: ${left.q.toFixed(1)} -> ${q.toFixed(1)} ms from submit to done`);
        left = null;
      }
      // (and on the way down, what the tier cost: the saving learned on the way up can be a costly spot's, too small)
      if (down && t - down.t > SETTLE) {
        if (q > 0 && down.tier === tier) {
          saves[tier] = Math.max(saves[tier] ?? 0, q - down.q);
          if (q > display * 0.95) {
            log(`tier ${tier + 1} -> ${tier}: ${down.q.toFixed(1)} -> ${q.toFixed(1)} ms from submit to done, back`);
            back = true;
          }
        }
        down = null;
      }
      for (let i = 0; i < saves.length; i++) if (saves[i]) saves[i] *= 0.5 ** ((t - at) / SAVES_HALF);
      at = t;
      return back;
    },
    saving: (tier) => saves[tier] ?? 0,
  };
}
