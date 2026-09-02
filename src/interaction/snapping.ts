/**
 * Snapping for plan editing.
 *
 * Snapping is what separates a floor plan from a sketch. Without it every wall
 * lands at 3.9847 m and no two corners ever quite line up, so no room is ever
 * detected as enclosed. Four kinds are applied, in descending priority:
 *
 *   1. VERTEX snap — land exactly on an existing corner. Highest priority
 *      because joining corners is what closes a room, and being a centimetre
 *      out is invisible on screen but fatal to region detection.
 *   2. ALIGNMENT snap — line up with another corner's X or Z. This is what
 *      keeps a plan looking deliberate rather than hand-drawn.
 *   3. ANGLE snap — while drawing, hold the new wall to 15-degree increments
 *      from its anchor, so square corners are the default rather than an
 *      achievement.
 *   4. GRID snap — fall back to the nearest grid multiple.
 */

import { distance } from '@/scene/planGraph';
import type { PlanModel, Point2 } from '@/state/types';

/** Radius within which a point is pulled onto an existing corner, in metres. */
const VERTEX_SNAP_RADIUS = 0.22;

/** Radius within which a coordinate lines up with another corner's, in metres. */
const ALIGN_SNAP_RADIUS = 0.12;

/** Angle increments used while drawing, in degrees. */
const ANGLE_STEP_DEGREES = 15;

/** A nearby corner a drag can snap to. */
export interface SnapCandidate extends Point2 {
  id: string;
}

export interface SnapOptions {
  gridSize: number;
  /** The other end of a wall being drawn, which enables angle snapping. */
  anchor: Point2 | null;
  candidates: readonly SnapCandidate[];
}

/**
 * Collects corners worth snapping to.
 *
 * Only nearby vertices are considered — with a large plan, testing every corner
 * for alignment produces so many candidate lines that the cursor sticks to
 * something on almost every pixel.
 */
export function nearestSnapCandidates(
  plan: PlanModel,
  point: Point2,
  excludeVertexId?: string,
): SnapCandidate[] {
  const searchRadius = 6;
  const candidates: SnapCandidate[] = [];

  for (const vertex of plan.vertices) {
    if (vertex.id === excludeVertexId) continue;
    if (distance(vertex, point) > searchRadius) continue;
    candidates.push({ id: vertex.id, x: vertex.x, z: vertex.z });
  }
  return candidates;
}

/** Rounds to the nearest multiple of `step`. */
function roundTo(value: number, step: number): number {
  return step <= 0 ? value : Math.round(value / step) * step;
}

/** Applies the snapping ladder to a plan-space point. */
export function snapPoint(point: Point2, options: SnapOptions): Point2 {
  /* ---- 1. Land on an existing corner ---- */
  let nearest: SnapCandidate | null = null;
  let nearestDistance = VERTEX_SNAP_RADIUS;
  for (const candidate of options.candidates) {
    const d = distance(candidate, point);
    if (d < nearestDistance) {
      nearestDistance = d;
      nearest = candidate;
    }
  }
  if (nearest) return { x: nearest.x, z: nearest.z };

  /* ---- 2. Angle snap, while drawing ---- */
  let result = { ...point };
  if (options.anchor) {
    const snapped = snapToAngle(options.anchor, result);
    if (snapped) result = snapped;
  }

  /* ---- 3. Align with another corner's X or Z ---- */
  let alignedX: number | null = null;
  let alignedZ: number | null = null;
  let bestX = ALIGN_SNAP_RADIUS;
  let bestZ = ALIGN_SNAP_RADIUS;

  for (const candidate of options.candidates) {
    const dx = Math.abs(candidate.x - result.x);
    if (dx < bestX) {
      bestX = dx;
      alignedX = candidate.x;
    }
    const dz = Math.abs(candidate.z - result.z);
    if (dz < bestZ) {
      bestZ = dz;
      alignedZ = candidate.z;
    }
  }

  /* ---- 4. Grid ---- */
  return {
    x: alignedX ?? roundTo(result.x, options.gridSize),
    z: alignedZ ?? roundTo(result.z, options.gridSize),
  };
}

/**
 * Pulls a point onto the nearest 15-degree ray from an anchor.
 *
 * Returns null when the point is already close enough to an increment that
 * snapping would not move it, so the grid gets its turn instead.
 */
function snapToAngle(anchor: Point2, point: Point2): Point2 | null {
  const dx = point.x - anchor.x;
  const dz = point.z - anchor.z;
  const radius = Math.hypot(dx, dz);
  if (radius < 0.05) return null;

  const step = (ANGLE_STEP_DEGREES * Math.PI) / 180;
  const angle = Math.atan2(dz, dx);
  const snappedAngle = Math.round(angle / step) * step;

  // Only take over when the cursor is genuinely near an increment; otherwise a
  // deliberately oblique wall would be impossible to draw.
  const drift = Math.abs(angle - snappedAngle);
  if (drift > step * 0.35) return null;

  return {
    x: anchor.x + Math.cos(snappedAngle) * radius,
    z: anchor.z + Math.sin(snappedAngle) * radius,
  };
}
