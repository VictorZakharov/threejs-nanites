// The forest: the library's Nanite renderer (src/nanite-lib/) with the forest's look (look.ts: the planet, wind,
// tints, autumn) over the planted trees, bushes and statues (placement.ts: in that order in the instances).
import type * as THREE from 'three/webgpu';
import type { UniformArrayNode } from 'three/webgpu';
import { NaniteRenderer, type NaniteTextures } from '../nanite-lib/index.ts';
import { isModel, type BuiltTree } from '../trees.ts';
import type { TreeInstances } from '../placement.ts';
import { forestLook, forestWind, type ForestUniforms } from './look.ts';

export class NaniteForest extends NaniteRenderer {
  declare readonly u: ForestUniforms;
  /** Per type: 1 trees, 0 models (statues don't sway). */
  readonly windOf: UniformArrayNode<'float'>;
  readonly treeCount: number; // (of instanceCount: then the bushes, then statueCount models)
  readonly statueCount: number;

  constructor(renderer: THREE.WebGPURenderer, trees: BuiltTree[], instances: TreeInstances, textures: NaniteTextures) {
    const { wind, windOf } = forestWind(trees.map((t) => isModel(t.variant)));
    const n = instances.a.length / 4;
    super(renderer, trees, { a: instances.a, b: instances.b, firstModel: n - instances.statues }, textures, forestLook(wind, windOf, textures));
    this.u.wind = wind;
    this.windOf = windOf;
    this.treeCount = instances.trees;
    this.statueCount = instances.statues;
  }
}
