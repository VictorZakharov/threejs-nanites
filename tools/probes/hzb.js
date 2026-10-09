// The occlusion depth pyramid (HZB) of the current view: its levels (offset, width, height), and a sparse grid of
// level 0 and level 5 values. Depth is WebGPU's 0 (near) .. 1 (far, sky): the sky should read 1, the ground
// increase towards 1 with distance.
async (demo) => {
  const h = demo.forest.hzb;
  await demo.renderOnce();
  const buf = new Float32Array(await demo.renderer.getArrayBufferAsync(h.buf.value));
  const levels = h.levels.array.slice(0, h.count.value).map((l) => [l.x, l.y, l.z]);
  /** rows x cols samples of a level, as strings of 4-decimal values */
  const grid = ([off, w, hh], rows, cols) => {
    const out = [];
    for (let j = 0; j < rows; j++) {
      const y = Math.floor(((j + 0.5) * hh) / rows);
      const line = [];
      for (let i = 0; i < cols; i++) line.push(buf[off + y * w + Math.floor(((i + 0.5) * w) / cols)].toFixed(4));
      out.push(line.join(' '));
    }
    return out;
  };
  return { size: [h.size.value.x, h.size.value.y], levels, level0: grid(levels[0], 8, 8), level5: grid(levels[Math.min(5, levels.length - 1)], 4, 4) };
}
