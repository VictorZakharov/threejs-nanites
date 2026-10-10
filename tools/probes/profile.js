// GPU profile (src/profile.ts, the perf panel's PROFILE button): runs the real loop at the view, switches one
// feature off at a time, prints median render/compute ms per step and what each feature costs. `--query=auto=1`
// to profile at the quality auto settles on (otherwise the harness's fixed quality).
async (demo) => demo.withLoop(() => demo.profile())
