/**
 * The shape a roof has to cover.
 *
 * A roof does not sit on the room outlines — it sits on the OUTSIDE of the
 * outermost walls, and then reaches past them by the overhang. So this module
 * answers three questions, in order:
 *
 *   1. Which walls form the outside of the building? (There may be more than
 *      one building: a detached garage drawn beside the house is its own
 *      structure and gets its own roof.)
 *   2. How thick is each of those walls, so the eave line clears it?
 *   3. Where does the eave line run, once the overhang is added?
 *
 * Everything here is DERIVED. Nothing about the footprint is stored, because a
 * stored footprint is a footprint that is wrong the moment somebody drags a
 * wall — and a roof that no longer fits the house is worse than no roof, since
 * it looks finished.
 */

import { offsetPolygonEdges } from './skeleton';
import { outerBoundaries, type Outline } from '@/scene/planGraph';
import type { Level, Point2 } from '@/state/types';

/** One free-standing structure's outline, ready for a roof. */
export interface Footprint {
  /**
   * The wall centreline, anticlockwise, with collinear runs merged.
   *
   * Merged because two walls in a straight line — which is what you get the
   * moment a wall is split to hang a door on — are one eave, not two, and a
   * roof built over them as two would put a hip between them.
   */
  outline: Point2[];
  /**
   * The walls along each edge. Usually one; more where a run was merged.
   *
   * Indexed by edge: edge i runs from `outline[i]` to `outline[i + 1]`.
   */
  wallIds: string[][];
  /** Half the thickness of the thickest wall on each edge, in metres. */
  halfThickness: number[];
  /** Height of the wall head above the storey's floor, per edge, in metres. */
  wallHeight: number[];
}

const COLLINEAR_TOLERANCE = 1e-6;

/**
 * Every free-standing structure on a storey, largest first.
 *
 * A storey with no enclosed outline — a single wall, or nothing drawn yet —
 * produces nothing rather than a degenerate shape, and the roof builder reports
 * that as a roof it cannot place.
 */
export function footprintsOf(level: Level): Footprint[] {
  const thicknessOf = new Map<string, number>();
  const heightOf = new Map<string, number>();
  for (const wall of level.plan.walls) {
    thicknessOf.set(wall.id, wall.thickness);
    heightOf.set(wall.id, wall.height);
  }

  const footprints: Footprint[] = [];
  for (const outline of outerBoundaries(level.plan)) {
    const merged = mergeCollinear(outline);
    if (merged.outline.length < 3) continue;

    footprints.push({
      ...merged,
      halfThickness: merged.wallIds.map((ids) => {
        // The thickest wall on the run decides, because the eave has to clear
        // the wall it actually sits on, not the average of a run.
        const thickest = ids.reduce((most, id) => Math.max(most, thicknessOf.get(id) ?? 0), 0);
        return thickest / 2;
      }),
      wallHeight: merged.wallIds.map((ids) => {
        const tallest = ids.reduce((most, id) => Math.max(most, heightOf.get(id) ?? 0), 0);
        return tallest > 0 ? tallest : level.wallHeight;
      }),
    });
  }

  return footprints;
}

/**
 * The structure a roof belongs to.
 *
 * Named by one of its walls, so that adding a room to the house does not hand
 * the garage's roof to the house. With no anchor — or an anchor whose wall has
 * since been deleted — the largest structure is taken, which is what a plan
 * with one building always wants.
 */
export function footprintFor(level: Level, anchorWallId: string | null): Footprint | null {
  const footprints = footprintsOf(level);
  if (footprints.length === 0) return null;

  if (anchorWallId) {
    const named = footprints.find((footprint) =>
      footprint.wallIds.some((ids) => ids.includes(anchorWallId)),
    );
    if (named) return named;
  }

  return footprints[0]!;
}

/**
 * Where the eaves run: the outline pushed out past the walls and overhung.
 *
 * One offset from the centreline rather than two in sequence, because offsetting
 * an offset re-cuts every corner twice and the second cut is made against a
 * mitre rather than against a wall.
 */
export function eaveOutline(footprint: Footprint, overhang: number): Point2[] {
  return offsetPolygonEdges(
    footprint.outline,
    footprint.halfThickness.map((half) => half + Math.max(0, overhang)),
  );
}

/**
 * Reduces a traced boundary to the outline a roof can be built on.
 *
 * Two things have to go, and both come from perfectly ordinary drawing:
 *
 *   STRAIGHT-THROUGH CORNERS. A wall split in two to carry a door is still one
 *   side of the house. Left as two, the straight skeleton sees two eaves
 *   meeting at a 180 degree corner and — correctly, and uselessly — puts a hip
 *   line between them.
 *
 *   DOUBLING BACK. Draw two rectangles that share part of a side, which is how
 *   most people draw an L, and the boundary walks out along the shared line and
 *   straight back down it. That spur encloses no area, so it does not show up
 *   as a wrong shape; it shows up as a roof solver that cannot make progress,
 *   which is far harder to recognise. Dropping the corner it turns at leaves
 *   the outline the drawing actually meant.
 *
 * Both are applied until neither finds anything, because each can create work
 * for the other: removing a spur regularly leaves a straight-through corner
 * where the two remaining pieces line up.
 */
function mergeCollinear(outline: Outline): { outline: Point2[]; wallIds: string[][] } {
  let points = outline.polygon.map((point) => ({ x: point.x, z: point.z }));
  let walls = outline.wallIds.map((id) => (id ? [id] : []));
  if (points.length < 3) return { outline: [], wallIds: [] };

  for (let pass = 0; pass < points.length + 4; pass++) {
    const reduced = removeOneCorner(points, walls);
    if (!reduced) break;
    points = reduced.outline;
    walls = reduced.wallIds;
    if (points.length < 3) return { outline: [], wallIds: [] };
  }

  /*
   * Winding is checked rather than corrected. `prepare` would reverse a
   * clockwise loop, and reversing the points without reversing the wall list to
   * match hands every eave its neighbour's thickness — so an unexpectedly wound
   * outline is refused instead, and the roof reports that it cannot be built
   * rather than being built wrong.
   */
  if (points.length < 3 || signedArea(points) <= 0) return { outline: [], wallIds: [] };

  return { outline: points, wallIds: walls };
}

/**
 * Drops the first corner that is not really a corner, or null if there is none.
 *
 * One at a time, because removing a corner renumbers everything after it and
 * merges two wall runs into one — and doing that inside a loop over the same
 * array is how an outline ends up with the walls one place out.
 */
function removeOneCorner(
  points: readonly Point2[],
  wallIds: readonly string[][],
): { outline: Point2[]; wallIds: string[][] } | null {
  const count = points.length;

  for (let i = 0; i < count; i++) {
    const prev = points[(i - 1 + count) % count]!;
    const here = points[i]!;
    const next = points[(i + 1) % count]!;

    const a = direction(prev, here);
    const b = direction(here, next);
    const turn = a.x * b.z - a.z * b.x;
    const facing = a.x * b.x + a.z * b.z;

    const straightOn = Math.abs(turn) < COLLINEAR_TOLERANCE && facing > 0;
    const doublesBack = Math.abs(turn) < COLLINEAR_TOLERANCE && facing < 0;
    if (!straightOn && !doublesBack) continue;

    // The edge arriving at this corner and the edge leaving it become one, so
    // the new edge carries the walls of both.
    const incoming = (i - 1 + count) % count;
    const merged: string[] = [];
    for (const id of [...(wallIds[incoming] ?? []), ...(wallIds[i] ?? [])]) {
      if (!merged.includes(id)) merged.push(id);
    }

    const outPoints: Point2[] = [];
    const outWalls: string[][] = [];
    for (let j = 0; j < count; j++) {
      if (j === i) continue;
      outPoints.push(points[j]!);
      outWalls.push(j === incoming ? merged : (wallIds[j] ?? []));
    }

    return { outline: outPoints, wallIds: outWalls };
  }

  return null;
}

/** Shoelace signed area; positive is anticlockwise. */
function signedArea(polygon: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const here = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    sum += here.x * next.z - next.x * here.z;
  }
  return sum / 2;
}

function direction(a: Point2, b: Point2): Point2 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  return len < 1e-12 ? { x: 0, z: 0 } : { x: dx / len, z: dz / len };
}
