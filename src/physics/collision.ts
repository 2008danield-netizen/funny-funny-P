/**
 * Collision detection and resolution, in plan.
 *
 * -----------------------------------------------------------------------------
 * WHY 2D
 *
 * Furniture in a room is a 2D problem wearing a 3D costume. Everything stands on
 * the floor, nothing tumbles, and a sofa either overlaps a wall in plan or it
 * does not — the third dimension contributes nothing except cost. So collision
 * runs entirely on oriented rectangles in the XZ plane, which is exact, fast
 * enough to run on every frame of a drag, and needs no physics engine.
 *
 * The one place height matters is openings: a doorway is a gap a sofa can pass
 * through, while a window with a sill above the floor is solid at furniture
 * height. `wallColliders` handles that by splitting a wall into its solid spans.
 *
 * -----------------------------------------------------------------------------
 * HOW IT RESOLVES
 *
 * Overlap is detected with the Separating Axis Theorem, which for two rectangles
 * means testing four axes: the two edge normals of each box. If the projections
 * overlap on every axis the boxes intersect, and the axis with the SMALLEST
 * overlap gives the minimum translation vector — the shortest push that
 * separates them.
 *
 * Pushing along the MTV rather than reversing the whole move is what makes
 * dragging feel right: a sofa shoved into a wall slides ALONG the wall instead
 * of sticking, because the component of the motion parallel to the wall
 * survives while the perpendicular component is cancelled.
 */

import type { Point2 } from '@/state/types';

/** An oriented rectangle on the floor plane. */
export interface Obb {
  center: Point2;
  /** Half-extent along the box's local X axis. */
  halfWidth: number;
  /** Half-extent along the box's local Z axis. */
  halfDepth: number;
  /** Rotation about Y, in radians. */
  rotation: number;
}

/** A collider, tagged so the solver can explain what blocked a move. */
export interface Collider extends Obb {
  kind: 'wall' | 'furniture';
  /** Wall ID or furniture item ID. */
  id: string;
}

/**
 * Overlaps shallower than this count as touching, not intersecting.
 *
 * Without it the solver never finishes. It resolves a contact to exactly the
 * padding gap, and the next test then computes a penetration of "zero" that
 * floating point renders as 2e-17 — a positive number, so the boxes are
 * reported as still overlapping, pushed by 2e-17, and tested again, forever.
 * A micrometre is far below anything that can matter in a room.
 */
const CONTACT_EPSILON = 1e-6;

/** Result of a separating-axis test. */
export interface Overlap {
  /** Unit vector along which to push `a` to separate it from `b`. */
  axis: Point2;
  /** How far along `axis` the push must go. */
  depth: number;
  /**
   * The OTHER way out along the same axis, and its cost.
   *
   * The shortest escape is usually right, but not always: a sofa dropped dead
   * centre on a wall can be pushed either way for the same distance, and one of
   * those directions is out of the building. The solver uses this alternative
   * whenever the shortest push would land somewhere illegal.
   */
  altAxis: Point2;
  altDepth: number;
}

/* ------------------------------ Box geometry --------------------------- */

/** The four corners of an OBB, anticlockwise. */
export function obbCorners(box: Obb): Point2[] {
  const cos = Math.cos(box.rotation);
  const sin = Math.sin(box.rotation);

  // Local axes of the box in world space.
  const ax = { x: cos, z: sin };
  const az = { x: -sin, z: cos };

  const w = box.halfWidth;
  const d = box.halfDepth;

  return [
    { x: box.center.x - ax.x * w - az.x * d, z: box.center.z - ax.z * w - az.z * d },
    { x: box.center.x + ax.x * w - az.x * d, z: box.center.z + ax.z * w - az.z * d },
    { x: box.center.x + ax.x * w + az.x * d, z: box.center.z + ax.z * w + az.z * d },
    { x: box.center.x - ax.x * w + az.x * d, z: box.center.z - ax.z * w + az.z * d },
  ];
}

/** The two distinct edge normals of an OBB. */
function obbAxes(box: Obb): Point2[] {
  const cos = Math.cos(box.rotation);
  const sin = Math.sin(box.rotation);
  // Opposite edges are parallel, so only two of the four normals are distinct.
  return [
    { x: cos, z: sin },
    { x: -sin, z: cos },
  ];
}

/** Projects a set of points onto an axis, returning the extent covered. */
function project(points: readonly Point2[], axis: Point2): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const value = point.x * axis.x + point.z * axis.z;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/**
 * Tests two boxes, returning the minimum translation vector or null if apart.
 *
 * `padding` inflates the test so that resolved contacts leave a small gap
 * rather than resting at exactly zero distance, where floating-point noise
 * makes the result flicker between touching and overlapping.
 */
export function testObb(a: Obb, b: Obb, padding = 0): Overlap | null {
  const cornersA = obbCorners(a);
  const cornersB = obbCorners(b);
  const axes = [...obbAxes(a), ...obbAxes(b)];

  let bestAxis: Point2 | null = null;
  let bestDepth = Infinity;
  let bestAltDepth = Infinity;

  for (const axis of axes) {
    const projA = project(cornersA, axis);
    const projB = project(cornersB, axis);

    /*
     * Penetration is the distance `a` must travel to clear `b`, and there are
     * two ways out: forwards along the axis, or backwards. The shorter one wins.
     *
     * The tempting shortcut — the length of the intervals' intersection,
     * min(maxes) - max(mins) — is WRONG whenever one projection contains the
     * other, which is exactly what happens when a piece of furniture is dropped
     * straight onto a thin wall: the wall's 20 cm projection sits entirely
     * inside the sofa's, the shortcut reports a 20 cm penetration, and the sofa
     * is pushed 20 cm and is still inside the wall. It then reports 20 cm again
     * on the next pass, and the solver runs out of iterations having achieved
     * nothing.
     */
    // Padding inflates `a` by half a gap on each side, which has to happen
    // BEFORE the separation test — adding it to the result afterwards would
    // report two exactly-touching boxes as separate and never open the gap.
    const forwards = projB.max - projA.min + padding;
    const backwards = projA.max - projB.min + padding;

    // A gap on any single axis proves the boxes are apart: stop immediately.
    if (forwards <= CONTACT_EPSILON || backwards <= CONTACT_EPSILON) return null;

    const overlap = Math.min(forwards, backwards);

    if (overlap < bestDepth) {
      bestDepth = overlap;
      bestAltDepth = Math.max(forwards, backwards);
      // The direction falls out of which way was shorter; no separate test of
      // which side the centres lie on is needed.
      bestAxis = forwards < backwards ? axis : { x: -axis.x, z: -axis.z };
    }
  }

  if (!bestAxis) return null;
  return {
    axis: bestAxis,
    depth: bestDepth,
    altAxis: { x: -bestAxis.x, z: -bestAxis.z },
    altDepth: bestAltDepth,
  };
}

/** True when the two boxes overlap at all. */
export function obbIntersects(a: Obb, b: Obb, padding = 0): boolean {
  return testObb(a, b, padding) !== null;
}

/* --------------------------------- Solver ------------------------------ */

export interface SolveOptions {
  /** Everything the moving box must not overlap. */
  colliders: readonly Collider[];
  /** Gap to leave at every resolved contact. */
  padding: number;
  /** Maximum resolution passes before the move is rejected. */
  iterations: number;
  /**
   * Returns true when a position is acceptable on grounds other than overlap —
   * used to require that a piece stays inside a room.
   */
  isPositionValid?: (center: Point2) => boolean;
}

export interface SolveResult {
  /** Where the box ended up. */
  center: Point2;
  /** True when a legal position was found. */
  resolved: boolean;
  /** IDs of the colliders that were pushed against, for UI feedback. */
  blockedBy: string[];
}

/**
 * Finds the nearest legal position for a box, given a desired one.
 *
 * Iterative because resolving one contact can create another — pushing a sofa
 * out of a wall may push it into a table. Each pass separates the deepest
 * remaining overlap, which converges quickly in the geometry rooms actually
 * have. Corners are the hard case: a box wedged between two perpendicular walls
 * can be pushed back and forth, which is why there is an iteration cap and a
 * rejection path rather than a loop that assumes success.
 */
export function solvePosition(desired: Obb, options: SolveOptions): SolveResult {
  const box: Obb = { ...desired, center: { ...desired.center } };
  const blockedBy = new Set<string>();

  for (let pass = 0; pass < options.iterations; pass++) {
    let deepest: { overlap: Overlap; collider: Collider } | null = null;

    for (const collider of options.colliders) {
      const overlap = testObb(box, collider, options.padding);
      if (!overlap) continue;
      if (!deepest || overlap.depth > deepest.overlap.depth) {
        deepest = { overlap, collider };
      }
    }

    if (!deepest) {
      // Clear of everything. The position is only legal if it also satisfies
      // the caller's own test (in practice: still inside a room).
      const valid = options.isPositionValid?.(box.center) ?? true;
      return { center: box.center, resolved: valid, blockedBy: [...blockedBy] };
    }

    blockedBy.add(deepest.collider.id);

    const { overlap } = deepest;
    const shortest = {
      x: box.center.x + overlap.axis.x * overlap.depth,
      z: box.center.z + overlap.axis.z * overlap.depth,
    };

    /*
     * Prefer the shortest escape, but not blindly.
     *
     * Dropping a sofa exactly onto a wall gives two equally short ways out, one
     * of which is through the wall and into the garden. Whenever the shortest
     * push would land somewhere the caller rejects — in practice, outside every
     * room — the longer escape along the same axis is tried instead. That is
     * what makes "drop it on a wall" put the sofa in the room rather than
     * outside the building.
     */
    if (options.isPositionValid && !options.isPositionValid(shortest)) {
      const alternative = {
        x: box.center.x + overlap.altAxis.x * overlap.altDepth,
        z: box.center.z + overlap.altAxis.z * overlap.altDepth,
      };
      box.center = options.isPositionValid(alternative) ? alternative : shortest;
    } else {
      box.center = shortest;
    }
  }

  // Ran out of passes: the box is wedged somewhere it cannot fit.
  return { center: box.center, resolved: false, blockedBy: [...blockedBy] };
}

/**
 * Tries to seat a box flush against a nearby wall.
 *
 * Returns a rotation and position, or null when no wall is close enough. This
 * is what makes placing a sofa feel deliberate: real furniture is pushed
 * against walls, and expecting the user to hand-align a bookcase to a wall by
 * eye is the kind of fiddle that makes a tool feel unfinished.
 *
 * The piece is turned so its BACK faces the wall, which is the correct
 * orientation for the things people put against walls — sofas, beds, bookcases,
 * sideboards all face into the room.
 */
export function snapToWall(
  box: Obb,
  walls: readonly Collider[],
  maxDistance: number,
  padding: number,
): { center: Point2; rotation: number } | null {
  let best: { center: Point2; rotation: number; distance: number } | null = null;

  for (const wall of walls) {
    if (wall.kind !== 'wall') continue;

    // The wall's own axes: local X runs along it, local Z is its normal.
    const cos = Math.cos(wall.rotation);
    const sin = Math.sin(wall.rotation);
    const along = { x: cos, z: sin };
    const normal = { x: -sin, z: cos };

    const delta = { x: box.center.x - wall.center.x, z: box.center.z - wall.center.z };
    const distanceAlong = delta.x * along.x + delta.z * along.z;
    const distanceOut = delta.x * normal.x + delta.z * normal.z;

    // Only consider walls the piece is actually beside, not ones it is past.
    if (Math.abs(distanceAlong) > wall.halfWidth + box.halfWidth) continue;

    const side = distanceOut >= 0 ? 1 : -1;
    // Distance from the piece's back to the wall's face.
    const gap = Math.abs(distanceOut) - wall.halfDepth - box.halfDepth;
    if (gap > maxDistance || gap < -box.halfDepth) continue;

    /*
     * Face away from the wall: the piece's local +Z (its front) must point
     * along the outward direction `n`.
     *
     * A box's local Z axis is (-sin r, cos r), so solving (-sin r, cos r) = n
     * gives r = atan2(-n.x, n.z). Getting the sign wrong here seats furniture
     * facing INTO the wall, which looks almost right in a screenshot and is
     * completely wrong to use.
     */
    const outward = { x: normal.x * side, z: normal.z * side };
    const rotation = Math.atan2(-outward.x, outward.z);

    // With that rotation the piece's depth axis is the wall normal, so seat it
    // exactly one half-depth plus the contact gap off the wall's face.
    const seat = wall.halfDepth + box.halfDepth + padding;
    const center = {
      x: wall.center.x + along.x * distanceAlong + normal.x * seat * side,
      z: wall.center.z + along.z * distanceAlong + normal.z * seat * side,
    };

    if (!best || gap < best.distance) best = { center, rotation, distance: gap };
  }

  return best ? { center: best.center, rotation: best.rotation } : null;
}

/* ------------------------------ Containment ---------------------------- */

/**
 * True when every corner of a box lies inside a polygon.
 *
 * Used to keep furniture within a room. Corner-only testing is exact for the
 * convex rooms most plans are made of; for a concave room a box could in
 * principle span a notch with all four corners inside, but the walls forming
 * that notch are colliders in their own right and stop it first.
 */
export function obbInsidePolygon(box: Obb, polygon: readonly Point2[]): boolean {
  for (const corner of obbCorners(box)) {
    if (!pointInPolygon(corner, polygon)) return false;
  }
  return true;
}

/** Ray-casting parity test. Duplicated from planGraph to keep physics standalone. */
export function pointInPolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const straddles = a.z > point.z !== b.z > point.z;
    if (!straddles) continue;
    const crossingX = ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
    if (point.x < crossingX) inside = !inside;
  }
  return inside;
}
