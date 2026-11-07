// GPU profile (src/profile.ts, the perf panel's PROFILE button): runs the real loop at the view, switches one
// feature off at a time, prints median render/compute ms per step and what each feature costs. `--query=auto=1`
// to profile at the quality auto settles on (otherwise the harness's fixed quality), after ?profilewait= s (0; 25 to let
// auto quality settle first).
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) =>
  demo.withLoop(async () => {
    await new Promise((r) => setTimeout(r, Number(new URLSearchParams(location.search).get('profilewait') ?? 0) * 1000));
    return demo.profile();
  })
