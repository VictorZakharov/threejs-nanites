// Shared types. TSL nodes are typed by their shader type in three.js's typings (`Node<'vec3'>` has .mul etc., a
// bare `Node` has none of the operators), so helpers take and return the concrete kinds below.
import type { Node } from 'three/webgpu';

export type Float = Node<'float'>;
export type Uint = Node<'uint'>;
export type Int = Node<'int'>;
export type Bool = Node<'bool'>;
export type Vec2 = Node<'vec2'>;
export type Vec3 = Node<'vec3'>;
export type Vec4 = Node<'vec4'>;
export type UVec4 = Node<'uvec4'>;
export type IVec2 = Node<'ivec2'>;
