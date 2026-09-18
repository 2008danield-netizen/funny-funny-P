/**
 * Giving flat surfaces enough vertices to carry light.
 *
 * -----------------------------------------------------------------------------
 * EVERY WALL IN THIS APP IS TWO TRIANGLES.
 *
 * So is every floor and every ceiling. That is the literal minimum a rectangle
 * can be made of, and for a long time it was the right answer: a flat painted
 * plane under uniform light needs nothing more, and the app had uniform light.
 *
 * It stops being the right answer the moment anything wants to VARY across a
 * surface. Light falling off as you move away from a window, a corner going
 * dark, the underside of a shelf shading the wall beneath it — all of those are
 * gradients, and a gradient needs somewhere to live. With four corner vertices
 * the only thing a wall can express is a single flat tone, and no amount of
 * clever lighting changes that.
 *
 * This is therefore not a visual improvement on its own. Subdividing a wall and
 * changing nothing else produces a byte-for-byte identical picture. It is the
 * canvas, and everything after it is the painting.
 *
 * -----------------------------------------------------------------------------
 * WHY A TARGET EDGE LENGTH RATHER THAN A SUBDIVISION COUNT.
 *
 * "Subdivide four times" gives a 0.5 m cupboard wall 4096 triangles it has no
 * use for, and a 9 m living room wall 4096 it badly needs more than. Rooms in
 * this app are any shape a person draws, so the only stable instruction is a
 * size in METRES: no triangle edge longer than this. A small wall then costs
 * almost nothing and a long one gets what it needs, without anybody having to
 * pick a number per room.
 */

import * as THREE from 'three';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';

/**
 * Longest triangle edge allowed on a surface that carries baked light, in metres.
 *
 * A quarter of a metre. The number is set by what the bake has to represent: the
 * darkening in a room corner falls off over roughly half a metre, so samples
 * need to be comfortably closer together than that or the gradient comes out as
 * a visible facet rather than a shade.
 *
 * Going finer is tempting and expensive in the wrong place. The cost here is not
 * the triangles — a modern GPU does not notice a few thousand — it is the BAKE,
 * which casts a hundred rays from every vertex. Halving this quadruples the
 * vertex count and therefore quadruples the time somebody waits after editing a
 * wall.
 */
export const LIGHT_EDGE = 0.25;

/**
 * The most triangles one surface may be cut into.
 *
 * A budget rather than an emergency brake, and the difference matters. The first
 * version checked a cap between passes and stopped when it was exceeded, which
 * leaves a surface HALF SUBDIVIDED — fine near one corner, coarse at the far
 * end, because the modifier works through triangles in order. Under baked light
 * that is worse than a uniformly coarse surface: the resolution of the shading
 * visibly changes across the floor, which looks like a bug rather than like low
 * detail.
 *
 * So the budget is spent up front instead, by coarsening the target edge until
 * the whole surface fits inside it. A huge floor gets an even, coarser grid; an
 * ordinary room never comes near the limit and gets exactly what it asked for.
 */
const MAX_TRIANGLES = 24000;

/**
 * Cuts a geometry down to a maximum edge length.
 *
 * Returns the ORIGINAL geometry untouched if it is already fine enough, which
 * matters because this runs on every plan edit and most edits do not change most
 * surfaces.
 */
export function subdivideForLight(
  geometry: THREE.BufferGeometry,
  maxEdge = LIGHT_EDGE,
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  if (!position) return geometry;

  if (longestEdge(geometry) <= maxEdge) return geometry;

  /*
   * Coarsen the target if this surface is too big to afford it.
   *
   * Two triangles per grid cell, so the cell size that fits the budget is the
   * square root of area-per-cell. The site terrain is 72 m across: at a quarter
   * metre that is 165,000 triangles for a lawn nobody looks at closely, and this
   * is what stops that happening without anybody having to remember to exclude
   * it by hand.
   */
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const area = box
    ? Math.max(
        (box.max.x - box.min.x) * (box.max.y - box.min.y),
        (box.max.x - box.min.x) * (box.max.z - box.min.z),
        (box.max.y - box.min.y) * (box.max.z - box.min.z),
      )
    : 0;
  /*
   * Seven triangles per square of the target edge, not two.
   *
   * Two is what a clean grid would cost, and the modifier does not produce a
   * clean grid: it splits along longest edges, which makes many thin triangles
   * rather than neat squares. Measured on a 30 x 20 m surface asking for a
   * quarter-metre edge, it produced 65,536 triangles where an ideal grid would
   * have been 19,200 — an overshoot of about three and a half times. Seven is
   * that measured factor, and using the theoretical two instead is how the first
   * version sailed past its own budget.
   */
  const affordable = Math.sqrt((area * 7) / MAX_TRIANGLES);
  const target = Math.max(maxEdge, affordable);

  /*
   * The modifier needs non-indexed geometry: it works by splitting triangles,
   * and a shared index buffer makes that ambiguous. `toNonIndexed` costs a copy
   * and is what the modifier would do internally anyway.
   */
  const source = geometry.index ? geometry.toNonIndexed() : geometry;

  /*
   * Iterated rather than trusted to one pass.
   *
   * `TessellateModifier` splits each over-long triangle ONCE per call, along its
   * longest edge. A triangle four times too long therefore needs several passes,
   * and calling it once leaves a surface that looks subdivided in the small
   * places and is still two triangles in the big ones — which is exactly the
   * case that matters.
   */
  /*
   * Iterated, because one call does not finish the job.
   *
   * The modifier splits each over-long triangle along its LONGEST edge only,
   * into two. That does not halve the other two edges — a right triangle cut
   * across its hypotenuse leaves two triangles whose longest edges are the
   * original legs — so convergence is markedly slower than the halving it looks
   * like. Six passes of one iteration each left a six-metre floor at 0.49 m,
   * still twice the target.
   */
  let result = source;
  for (let pass = 0; pass < 6; pass++) {
    if (longestEdge(result) <= target) break;
    result = new TessellateModifier(target, 8).modify(result);
  }

  /*
   * Keep the coarse version, because something else needs it.
   *
   * Subdividing turns a wall from about twenty triangles into several hundred,
   * and anything that RAYCASTS against the building pays for every one of them.
   * The sky bake casts a couple of hundred thousand rays, so the subdivision
   * made it four hundred times more expensive — enough to hang the tab before
   * the canvas had even appeared.
   *
   * The two want opposite things and both are right: shading wants many small
   * triangles, intersection wants few large ones. They describe the same
   * surface, so the coarse one is kept alongside rather than recomputed, and
   * costs a few hundred bytes for a wall.
   */
  result.userData.coarse = geometry.clone();

  // The intermediate copy was a throwaway, and holding it would leak.
  if (source !== geometry && source !== result) source.dispose();

  return result;
}

/** The longest triangle edge in a geometry, in world units. */
export function longestEdge(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  if (!position) return 0;

  const index = geometry.index;
  const count = index ? index.count : position.count;
  let longest = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  for (let i = 0; i < count; i += 3) {
    for (let edge = 0; edge < 3; edge++) {
      const i0 = index ? index.getX(i + edge) : i + edge;
      const i1 = index ? index.getX(i + ((edge + 1) % 3)) : i + ((edge + 1) % 3);
      a.fromBufferAttribute(position, i0);
      b.fromBufferAttribute(position, i1);
      const length = a.distanceTo(b);
      if (length > longest) longest = length;
    }
  }
  return longest;
}

/** How many triangles a geometry holds. */
export function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.index;
  if (index) return index.count / 3;
  const position = geometry.getAttribute('position');
  return position ? position.count / 3 : 0;
}
