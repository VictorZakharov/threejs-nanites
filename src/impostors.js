// Far-field trees: one camera-facing quad per tree, textured from an atlas baked at startup.
//
// Beyond ~1 km a tree is a handful of pixels tall, yet even its coarsest cluster cut costs two 128-triangle cluster
// draws. Trees whose projected height is under the impostor threshold are instead appended (by the GPU instance
// pass) to an impostor list and drawn as 2 triangles each, which is what makes a horizon of ~1M trees cheap.
//
// The atlases have three 256x512 tiles per tree variant (half float), one per viewing elevation (ELEVATIONS): tiles
// 0..n-1 from the side, n..2n-1 from 45 degrees up, 2n..3n-1 from straight above. The quad cross-fades between them
// by viewing elevation, so trees seen from the air don't turn into edge-on slivers. (With only side and top views, a
// pine seen from 45 degrees was the top view's dark splat: "piles of poop" instead of slanted cones.)
//
// The tiles are baked from the cluster DAG cut the real tree has at the switch (see dagCut), not from the full
// detail: coarse leaf LODs are fewer, bigger cards that round the crown off, and an impostor of the full-detail
// tree (star-shaped pines, gappy crowns) was a different picture from the geometry it replaces.
import * as THREE from 'three/webgpu';
import { Fn, If, Discard, texture, vec3, vec4, float, attribute, smoothstep, normalLocal, select, uint } from 'three/tsl';

export const TILE_W = 256;
export const TILE_H = 512;
/** Alpha-test cut-off of the impostor material. */
export const IMPOSTOR_CUT = 0.35;
/** The baked viewing elevations (degrees), one atlas column block each. */
export const ELEVATIONS = [0, 45, 90];

/**
 * The triangles of one tree at a uniform DAG cut: every cluster whose own error is within `err` (object space,
 * metres) and whose parent's isn't, as the runtime cut selects them at a distance where `err` projects to tau.
 * Returns { bark, leaves }, each { pos, nrm, uv, idx } (vertices shared, from the packed [x y z u nx ny nz v]).
 */
export function dagCut(t, err) {
  const nv = t.vtx.length / 8;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let i = 0; i < nv; i++) {
    const v = t.vtx.subarray(i * 8, i * 8 + 8);
    pos.set([v[0], v[1], v[2]], i * 3);
    nrm.set([v[4], v[5], v[6]], i * 3);
    uv.set([v[3], v[7]], i * 2);
  }
  const lists = [[], []]; // bark, leaves
  const n = t.meta.length / 4;
  for (let c = 0; c < n; c++) {
    const own = t.rec[c * 16 + 12], parent = t.rec[c * 16 + 13];
    if (!(own <= err && parent > err)) continue;
    const o = t.meta[c * 4], tris = t.meta[c * 4 + 1], kind = t.meta[c * 4 + 3];
    for (let k = 0; k < tris * 3; k++) lists[kind].push(t.idx[o + k]);
  }
  const part = (l) => ({ pos, nrm, uv, idx: new Uint32Array(l) });
  return { bark: part(lists[0]), leaves: part(lists[1]) };
}

/** The full-detail source meshes in dagCut's form (leaf cards are quads of 4 vertices). */
function fullDetail({ bark, leaves }) {
  const nq = leaves.pos.length / 3 / 4;
  const idx = new Uint32Array(nq * 6);
  for (let q = 0; q < nq; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  return { bark, leaves: { ...leaves, idx } };
}

/**
 * Bakes two atlases with the same layout: albedo (unlit colour, alpha = coverage) and normals (tree-local, xyz in
 * [-1, 1]). The impostors are lit at runtime like the real trees (same sun, sky light, shadow and fog), so they
 * match from every side and under any light; a baked *lit* picture was brighter than the real trees on their shady
 * side and popped at the switch.
 * @param trees  results of buildAllTrees (each with .src source meshes, the packed DAG and .variant)
 * @param tex    { bark, leaf } array textures, barkLayers / leafLayers per variant, leafAlpha(a, layer) node fn
 * @param cutPx  bake each tree at the DAG cut it has when it's this many pixels tall (at tau 1); 0 = full detail
 * @returns { texture, normals, frames: [{ w, h }], renderTarget } frame size (m) of each tile's quad (aspect 1:2)
 */
export function bakeImpostors(renderer, trees, tex, cutPx = 0) {
  const n = trees.length;
  const makeRT = () =>
    new THREE.RenderTarget(TILE_W * ELEVATIONS.length * n, TILE_H, {
      type: THREE.HalfFloatType,
      samples: 4,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
  const rt = makeRT(), rtN = makeRT();
  const frames = [];
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  const prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  for (const target of [rt, rtN]) {
    renderer.setRenderTarget(target);
    renderer.clear();
  }
  renderer.autoClear = false;

  trees.forEach((t, i) => {
    // (frame size from the full-detail tree: the same tile whichever cut is baked)
    const src = t.src;
    const { bark, leaves } = cutPx > 0 ? dagCut(t, t.height / cutPx) : fullDetail(src);
    const scenes = [new THREE.Scene(), new THREE.Scene()]; // albedo, normals
    const normalOut = (a) => vec4(normalLocal.normalize(), a);

    const barkGeo = new THREE.BufferGeometry();
    barkGeo.setAttribute('position', new THREE.BufferAttribute(bark.pos, 3));
    barkGeo.setAttribute('normal', new THREE.BufferAttribute(bark.nrm, 3));
    barkGeo.setAttribute('uv', new THREE.BufferAttribute(bark.uv, 2));
    barkGeo.setIndex(new THREE.BufferAttribute(bark.idx, 1));
    const barkMat = new THREE.MeshBasicNodeMaterial();
    barkMat.colorNode = vec4(texture(tex.bark, attribute('uv', 'vec2')).depth(float(tex.barkLayers[i])).rgb.mul(vec3(0.9, 0.86, 0.8)), 1);
    const barkNrm = new THREE.MeshBasicNodeMaterial();
    barkNrm.colorNode = normalOut(1);
    scenes[0].add(new THREE.Mesh(barkGeo, barkMat));
    scenes[1].add(new THREE.Mesh(barkGeo, barkNrm));

    if (leaves.idx.length) {
      const leafGeo = new THREE.BufferGeometry();
      leafGeo.setAttribute('position', new THREE.BufferAttribute(leaves.pos, 3));
      leafGeo.setAttribute('normal', new THREE.BufferAttribute(leaves.nrm, 3));
      leafGeo.setAttribute('uv', new THREE.BufferAttribute(leaves.uv, 2));
      leafGeo.setIndex(new THREE.BufferAttribute(leaves.idx, 1));
      const layer = tex.leafLayers[i];
      const l = texture(tex.leaf, attribute('uv', 'vec2')).depth(float(layer));
      const alpha = tex.leafAlpha(l.a, uint(layer));
      // the leaf material's colour without the per-tree tint (applied at runtime)
      const layerTint = layer === 2 ? vec3(0.5, 0.82, 0.85) : layer === 3 ? vec3(0.62, 0.78, 1.0) : vec3(1);
      const inner = smoothstep(-0.6, 0.8, normalLocal.y).mul(0.4).add(0.6);
      const col = l.rgb.mul(layerTint).mul(inner).mul(1.2);
      // cut out and write alpha 1: the MSAA resolve then gives true coverage (and coverage-premultiplied colour)
      const cutout = (out) => Fn(() => {
        If(alpha.lessThan(0.5), () => Discard());
        return out;
      })();
      const leafMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
      leafMat.colorNode = cutout(vec4(col, 1));
      const leafNrm = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
      leafNrm.colorNode = cutout(normalOut(1));
      scenes[0].add(new THREE.Mesh(leafGeo, leafMat));
      scenes[1].add(new THREE.Mesh(leafGeo, leafNrm));
    }

    // frame: tree base at the bottom, tile aspect 1:2
    let r = 0, h = 0;
    for (const p of [src.bark.pos, src.leaves.pos])
      for (let k = 0; k < p.length; k += 3) {
        r = Math.max(r, Math.abs(p[k]), Math.abs(p[k + 2]));
        h = Math.max(h, p[k + 1]);
      }
    const fw = Math.max(2 * r, h / 2) * 1.04;
    const fh = fw * 2;
    frames.push({ w: fw, h: fh });
    // every view is centred on the trunk axis at half the frame height (the runtime quad's pivot), looking from +z
    // tilted up by the elevation: screen right = +x, screen up = (0, cos e, -sin e) (from above: -z)
    ELEVATIONS.forEach((deg, k) => {
      const e = THREE.MathUtils.degToRad(deg);
      const cam = new THREE.OrthographicCamera(-fw / 2, fw / 2, fh / 2, -fh / 2, 0, 400);
      cam.position.set(0, fh / 2 + 200 * Math.sin(e), 200 * Math.cos(e));
      cam.up.set(0, Math.cos(e), -Math.sin(e));
      cam.lookAt(0, fh / 2, 0);
      const col = k * n + i;
      cam.updateMatrixWorld();
      [rt, rtN].forEach((target, j) => {
        renderer.setRenderTarget(target);
        target.viewport.set(col * TILE_W, 0, TILE_W, TILE_H);
        target.scissor.set(col * TILE_W, 0, TILE_W, TILE_H);
        target.scissorTest = true;
        renderer.clearDepth();
        renderer.render(scenes[j], cam);
      });
    });

    scenes.forEach((sc) => sc.traverse((o) => o.isMesh && o.geometry.dispose()));
  });

  for (const target of [rt, rtN]) {
    target.scissorTest = false;
    target.viewport.set(0, 0, TILE_W * ELEVATIONS.length * n, TILE_H);
  }
  renderer.autoClear = prevAutoClear;
  renderer.toneMapping = prevTone;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  return { texture: rt.texture, normals: rtN.texture, frames, renderTarget: rt };
}

/** Maps a type (uint node) to a value from a JS array via a select chain. */
export function lookup(values) {
  return (type) => {
    let node = float(values[values.length - 1]);
    for (let i = values.length - 2; i >= 0; i--) node = select(type.equal(uint(i)), float(values[i]), node);
    return node;
  };
}

/**
 * Coverage-preserving alpha for the atlas (the same idea as the leaves' coverageScales): a far impostor samples a
 * small mip where the leaves have been averaged into a semi-transparent haze that the alpha test mostly discards,
 * so the forest thins out with distance. Reads the baked atlas back once and finds, per tile and mip level, the
 * alpha scale that keeps the full-size tile's fraction of texels above `cut`.
 * @returns { scales: Float32Array (tile * levels + level), levels }
 */
export async function impostorCoverage(renderer, atlas, cut) {
  const rt = atlas.renderTarget;
  const W = rt.width, H = rt.height, tiles = W / TILE_W;
  const raw = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
  const half = (h) => {
    const e = (h >> 10) & 31, m = h & 1023;
    const v = e === 0 ? m / 1024 / 16384 : e === 31 ? 1 : (1 + m / 1024) * 2 ** (e - 15);
    return h & 0x8000 ? -v : v;
  };
  const alphaAt = raw instanceof Uint16Array ? (i) => half(raw[i * 4 + 3]) : (i) => raw[i * 4 + 3] / (raw instanceof Uint8Array ? 255 : 1);
  const levels = Math.log2(TILE_W) + 1;
  const scales = new Float32Array(tiles * levels);
  for (let t = 0; t < tiles; t++) {
    let w = TILE_W, h = TILE_H;
    let a = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = alphaAt(y * W + t * TILE_W + x);
    let target = 0;
    for (const v of a) if (v > cut) target++;
    target /= a.length;
    scales[t * levels] = 1;
    for (let l = 1; l < levels; l++) {
      const w2 = w >> 1, h2 = h >> 1;
      const b = new Float32Array(w2 * h2);
      for (let y = 0; y < h2; y++)
        for (let x = 0; x < w2; x++)
          b[y * w2 + x] = (a[2 * y * w + 2 * x] + a[2 * y * w + 2 * x + 1] + a[(2 * y + 1) * w + 2 * x] + a[(2 * y + 1) * w + 2 * x + 1]) / 4;
      a = b; w = w2; h = h2;
      // alpha value at the (1 - target) quantile becomes the new cut-off
      const sorted = Float32Array.from(a).sort();
      const q = sorted[Math.min(sorted.length - 1, Math.floor((1 - target) * sorted.length))];
      scales[t * levels + l] = Math.min(8, cut / Math.max(q, 1e-3));
    }
  }
  return { scales, levels };
}
