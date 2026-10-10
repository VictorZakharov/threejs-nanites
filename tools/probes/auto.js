// Auto quality (src/main.ts): runs the real loop for 8 s, flying forward, against a budget (`?autobudget=`, default
// 3 ms: tight enough on the dev GPU to reach the resolution steps a phone needs) and reports where the controller
// settled: tau, the resolution scale and the drawing-buffer size, GPU ms, fps.
async (demo) => demo.autoTest(8000, Number(new URLSearchParams(location.search).get('autobudget') ?? 3))
