// Far-field trees: one camera-facing quad per tree, textured from an atlas baked at startup.
//
// Beyond ~1 km a tree is a handful of pixels tall, yet even its coarsest cluster cut costs two 128-triangle cluster
// draws. Trees whose projected height is under the impostor threshold are instead appended (by the GPU instance
// pass) to an impostor list and drawn as 2 triangles each, which is what makes a horizon of ~1M trees cheap.
//
// The atlas has two 256x512 tiles per tree variant, the full-detail source meshes rendered with the scene's lighting
// (linear, half float) so an impostor matches the real tree it replaces: tiles 0..n-1 from the side, tiles n..2n-1
// from straight above (crown centred in the tile). The quad cross-fades between them by viewing elevation, so
// trees seen from the air don't turn into edge-on slivers.
import * as THREE from 'three/webgpu';
import { texture, vec3, vec4, float, attribute, smoothstep, normalLocal, normalViewGeometry, select, uint } from 'three/tsl';

export const TILE_W = 256;
export const TILE_H = 512;
/** Alpha-test cut-off of the impostor material. */
export const IMPOSTOR_CUT = 0.35;

/**
 * @param trees  results of buildAllTrees (each with .src source meshes and .variant)
 * @param tex    { bark, leaf } array textures, barkLayers / leafLayers per variant, leafAlpha(a, layer) node fn
 * @param light  { sunColor, sunIntensity, hemiSky, hemiGround, hemiIntensity }
 * @returns { texture, frames: [{ w, h }] } frame size (m) of each tile's quad (tile aspect 1:2), same for both views
 */
export function bakeImpostors(renderer, trees, tex, light) {
  const n = trees.length;
  const rt = new THREE.RenderTarget(TILE_W * 2 * n, TILE_H, {
    type: THREE.HalfFloatType,
    samples: 4,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
  const frames = [];
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.autoClear = false;

  trees.forEach((t, i) => {
    const { bark, leaves } = t.src;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(light.hemiSky, light.hemiGround, light.hemiIntensity));
    // the sun from the front, a little to the side and above: the average of how far trees are seen
    const sun = new THREE.DirectionalLight(light.sunColor, light.sunIntensity);
    sun.position.set(0.45, 0.75, 1);
    scene.add(sun);

    const barkGeo = new THREE.BufferGeometry();
    barkGeo.setAttribute('position', new THREE.BufferAttribute(bark.pos, 3));
    barkGeo.setAttribute('normal', new THREE.BufferAttribute(bark.nrm, 3));
    barkGeo.setAttribute('uv', new THREE.BufferAttribute(bark.uv, 2));
    barkGeo.setIndex(new THREE.BufferAttribute(bark.idx, 1));
    const barkMat = new THREE.MeshLambertNodeMaterial();
    barkMat.colorNode = vec4(texture(tex.bark, attribute('uv', 'vec2')).depth(float(tex.barkLayers[i])).rgb.mul(vec3(0.9, 0.86, 0.8)), 1);
    scene.add(new THREE.Mesh(barkGeo, barkMat));

    if (leaves.pos.length) {
      const nq = leaves.pos.length / 3 / 4;
      const idx = new Uint32Array(nq * 6);
      for (let q = 0; q < nq; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
      const leafGeo = new THREE.BufferGeometry();
      leafGeo.setAttribute('position', new THREE.BufferAttribute(leaves.pos, 3));
      leafGeo.setAttribute('normal', new THREE.BufferAttribute(leaves.nrm, 3));
      leafGeo.setAttribute('uv', new THREE.BufferAttribute(leaves.uv, 2));
      leafGeo.setIndex(new THREE.BufferAttribute(idx, 1));
      const layer = tex.leafLayers[i];
      const leafMat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
      const l = texture(tex.leaf, attribute('uv', 'vec2')).depth(float(layer));
      const layerTint = layer === 2 ? vec3(0.5, 0.82, 0.85) : layer === 3 ? vec3(0.62, 0.78, 1.0) : vec3(1);
      const inner = smoothstep(-0.6, 0.8, normalLocal.y).mul(0.4).add(0.6);
      const col = l.rgb.mul(layerTint).mul(vec3(0.92, 1, 0.8)).mul(inner).mul(1.2);
      leafMat.colorNode = vec4(col, tex.leafAlpha(l.a, uint(layer)));
      leafMat.emissiveNode = col.mul(0.12);
      leafMat.normalNode = normalViewGeometry;
      scene.add(new THREE.Mesh(leafGeo, leafMat));
    }

    // frame: tree base at the bottom, tile aspect 1:2
    let r = 0, h = 0;
    for (const p of [bark.pos, leaves.pos])
      for (let k = 0; k < p.length; k += 3) {
        r = Math.max(r, Math.abs(p[k]), Math.abs(p[k + 2]));
        h = Math.max(h, p[k + 1]);
      }
    const fw = Math.max(2 * r, h / 2) * 1.04;
    const fh = fw * 2;
    frames.push({ w: fw, h: fh });
    const side = new THREE.OrthographicCamera(-fw / 2, fw / 2, fh, 0, -200, 200);
    side.position.set(0, 0, 50);
    side.lookAt(0, 0, 0);
    // top view: same frame size, centred on the trunk axis (screen up = -z)
    const top = new THREE.OrthographicCamera(-fw / 2, fw / 2, fh / 2, -fh / 2, 0, 400);
    top.position.set(0, 200, 0);
    top.up.set(0, 0, -1);
    top.lookAt(0, 0, 0);
    for (const [cam, col] of [[side, i], [top, n + i]]) {
      cam.updateMatrixWorld();
      rt.viewport.set(col * TILE_W, 0, TILE_W, TILE_H);
      rt.scissor.set(col * TILE_W, 0, TILE_W, TILE_H);
      rt.scissorTest = true;
      renderer.render(scene, cam);
    }

    barkGeo.dispose();
    scene.traverse((o) => o.isMesh && o.geometry.dispose());
  });

  rt.scissorTest = false;
  rt.viewport.set(0, 0, TILE_W * 2 * n, TILE_H);
  renderer.autoClear = prevAutoClear;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  return { texture: rt.texture, frames, renderTarget: rt };
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
