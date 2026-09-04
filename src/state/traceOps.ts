/**
 * Turning what the detector found into walls somebody can build on.
 *
 * The detector's output is a list of lines in a photograph. What the plan needs
 * is a wall graph: corners shared between walls, walls that actually meet, and
 * thicknesses in metres. The gap between the two is this file, and it is not a
 * formality — a set of lines that each nearly touch is not a room, it is four
 * lines. Rooms are DETECTED from closed loops (see `scene/planGraph.ts`), so a
 * corner that misses by two centimetres is the difference between a floor plan
 * and a drawing of one.
 *
 * Three things happen here, in this order and for this reason:
 *
 *  1. STRAIGHTENING. Scans are skewed by a degree or two, and a photograph by
 *     more. Every wall inherits that skew, and it accumulates: a house traced
 *     off a two-degree scan has no square corners anywhere. So the dominant
 *     direction of the accepted walls is found and near-parallel walls are
 *     turned onto it. Walls genuinely at an angle are left alone.
 *  2. JOINING. Endpoints close to each other, or close to a corner already in
 *     the plan, become the same corner. This is what closes the loops.
 *  3. BUILDING. Vertices and walls are created, thicknesses converted from
 *     pixels to metres, and the plan normalised — as ONE edit, so the whole
 *     trace is a single undo step rather than forty.
 */

import { imageToWorld } from '@/plan/underlay';
import type { DetectedWall } from '@/plan/detect';
import { newVertexId, newWallId, normalizePlan } from './planOps';
import { PLAN_LIMITS, type DesignDocument, type Point2, type Underlay } from './types';

/** A proposed wall, in the world, ready to accept or reject. */
export interface TraceCandidate {
  id: string;
  from: Point2;
  to: Point2;
  /** Thickness in metres, or null where only one face was found. */
  thickness: number | null;
  confidence: number;
}

/** How close two corners have to be to become one, in metres. */
const JOIN_DISTANCE = 0.25;

/** How far off the dominant direction a wall may be and still be straightened. */
const STRAIGHTEN_TOLERANCE = (5 * Math.PI) / 180;

/* ------------------------------- Converting ------------------------------- */

/**
 * Puts the detector's output into the world, and throws away what is not worth
 * offering.
 *
 * Walls shorter than the plan's own minimum are dropped here rather than shown
 * and rejected: a scan produces a certain amount of confetti, and a list of two
 * hundred proposals with a hundred and sixty of them useless is a list nobody
 * reads.
 */
export function candidatesFrom(
  underlay: Underlay,
  detected: readonly DetectedWall[],
  minLength = PLAN_LIMITS.minWallLength * 3,
): TraceCandidate[] {
  const candidates: TraceCandidate[] = [];

  detected.forEach((wall, index) => {
    const from = imageToWorld(underlay, wall.from);
    const to = imageToWorld(underlay, wall.to);
    if (Math.hypot(to.x - from.x, to.z - from.z) < minLength) return;

    candidates.push({
      id: `trace-${index}`,
      from,
      to,
      thickness:
        wall.thicknessPixels === null
          ? null
          : clamp(
              wall.thicknessPixels * underlay.metresPerPixel,
              PLAN_LIMITS.wallThickness.min,
              PLAN_LIMITS.wallThickness.max,
            ),
      confidence: wall.confidence,
    });
  });

  return candidates;
}

/* ------------------------------ Straightening ----------------------------- */

/**
 * The direction the drawing is mostly in, modulo a right angle.
 *
 * Weighted by length, because one long wall says more about a building's
 * orientation than six short ones, and taken modulo 90 degrees because the two
 * directions of a rectangular building are the same fact. Circular mean rather
 * than an average of angles: 89 degrees and 1 degree average to 45, which is
 * exactly wrong.
 */
export function dominantAngle(candidates: readonly TraceCandidate[]): number {
  let sumSin = 0;
  let sumCos = 0;

  for (const candidate of candidates) {
    const length = Math.hypot(
      candidate.to.x - candidate.from.x,
      candidate.to.z - candidate.from.z,
    );
    if (length < 1e-6) continue;

    const angle = Math.atan2(candidate.to.z - candidate.from.z, candidate.to.x - candidate.from.x);
    // Four times the angle folds the four right-angled directions onto one, so
    // the mean of a rectangular plan is not pulled apart by its own corners.
    sumSin += Math.sin(angle * 4) * length;
    sumCos += Math.cos(angle * 4) * length;
  }

  if (Math.abs(sumSin) < 1e-12 && Math.abs(sumCos) < 1e-12) return 0;
  return Math.atan2(sumSin, sumCos) / 4;
}

/**
 * Turns walls that are nearly on the grid exactly onto it.
 *
 * Each wall rotates about its own middle, so a straightened wall stays where it
 * was rather than sliding along the building. Walls further off the grid than
 * the tolerance are genuinely at an angle and are left exactly as they are.
 */
export function straightenCandidates(
  candidates: readonly TraceCandidate[],
  gridAngle: number,
  tolerance = STRAIGHTEN_TOLERANCE,
): TraceCandidate[] {
  return candidates.map((candidate) => {
    const dx = candidate.to.x - candidate.from.x;
    const dz = candidate.to.z - candidate.from.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return candidate;

    const angle = Math.atan2(dz, dx);

    // The nearest of the four grid directions.
    let best = angle;
    let bestOff = Infinity;
    for (let quarter = 0; quarter < 4; quarter++) {
      const target = gridAngle + (quarter * Math.PI) / 2;
      const off = Math.abs(wrapToPi(angle - target));
      if (off < bestOff) {
        bestOff = off;
        best = target;
      }
    }
    if (bestOff > tolerance) return candidate;

    const middle = {
      x: (candidate.from.x + candidate.to.x) / 2,
      z: (candidate.from.z + candidate.to.z) / 2,
    };
    const half = length / 2;
    return {
      ...candidate,
      from: { x: middle.x - Math.cos(best) * half, z: middle.z - Math.sin(best) * half },
      to: { x: middle.x + Math.cos(best) * half, z: middle.z + Math.sin(best) * half },
    };
  });
}

/* -------------------------------- Accepting ------------------------------- */

export interface AcceptResult {
  /** How many walls were added. */
  added: number;
  /** How many corners the joining step merged into one. */
  joined: number;
}

/**
 * Adds accepted walls to a storey's plan, as one edit.
 *
 * Mutates a draft, so it belongs inside `designStore.edit` like every other
 * operation in this folder — which is what makes accepting forty walls one
 * undo step rather than forty.
 */
export function acceptCandidates(
  doc: DesignDocument,
  levelId: string,
  candidates: readonly TraceCandidate[],
  options: { straighten?: boolean; joinDistance?: number } = {},
): AcceptResult {
  const level = doc.levels.find((entry) => entry.id === levelId);
  if (!level || candidates.length === 0) return { added: 0, joined: 0 };

  const joinDistance = options.joinDistance ?? JOIN_DISTANCE;
  const prepared =
    options.straighten === false
      ? [...candidates]
      : straightenCandidates(candidates, dominantAngle(candidates));

  const plan = level.plan;

  /*
   * Corners already in the plan come first, so tracing a second wing onto a
   * house joins it to the wing already drawn instead of building a separate
   * structure two centimetres away from it.
   */
  interface Cluster {
    at: Point2;
    vertexId: string | null;
    count: number;
  }
  const clusters: Cluster[] = plan.vertices.map((vertex) => ({
    at: { x: vertex.x, z: vertex.z },
    vertexId: vertex.id,
    count: 1,
  }));

  let joined = 0;

  const clusterFor = (point: Point2): Cluster => {
    let best: Cluster | null = null;
    let bestDistance = joinDistance;

    for (const cluster of clusters) {
      const distance = Math.hypot(cluster.at.x - point.x, cluster.at.z - point.z);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = cluster;
      }
    }

    if (best) {
      joined += 1;
      // An existing corner does not move; a corner made of proposals settles on
      // the average of them, which pulls a slightly ragged trace square.
      if (!best.vertexId) {
        best.at = {
          x: (best.at.x * best.count + point.x) / (best.count + 1),
          z: (best.at.z * best.count + point.z) / (best.count + 1),
        };
      }
      best.count += 1;
      return best;
    }

    const fresh: Cluster = { at: { x: point.x, z: point.z }, vertexId: null, count: 1 };
    clusters.push(fresh);
    return fresh;
  };

  const walls = prepared.map((candidate) => ({
    candidate,
    start: clusterFor(candidate.from),
    end: clusterFor(candidate.to),
  }));

  // Vertices are created after all the clustering, so each one lands at its
  // settled position rather than where the first wall to reach it put it.
  const vertexIdOf = (cluster: Cluster): string => {
    if (cluster.vertexId) return cluster.vertexId;
    const id = newVertexId(plan);
    plan.vertices.push({ id, x: clampToPlan(cluster.at.x), z: clampToPlan(cluster.at.z) });
    cluster.vertexId = id;
    return id;
  };

  let added = 0;
  for (const wall of walls) {
    const start = vertexIdOf(wall.start);
    const end = vertexIdOf(wall.end);
    if (start === end) continue;

    // A wall between the same two corners as one already there is a duplicate,
    // which happens wherever the detector found both faces AND a stray line.
    const already = plan.walls.some(
      (existing) =>
        (existing.start === start && existing.end === end) ||
        (existing.start === end && existing.end === start),
    );
    if (already) continue;

    plan.walls.push({
      id: newWallId(plan),
      start,
      end,
      thickness: wall.candidate.thickness ?? plan.defaultWallThickness,
      height: plan.defaultWallHeight,
      faces: {},
      openings: [],
    });
    added += 1;
  }

  normalizePlan(plan);
  return { added, joined };
}

/* -------------------------------- Internals ------------------------------- */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampToPlan(value: number): number {
  return clamp(value, -PLAN_LIMITS.planExtent, PLAN_LIMITS.planExtent);
}

/** An angle folded into -pi..pi. */
function wrapToPi(angle: number): number {
  let wrapped = angle % (Math.PI * 2);
  if (wrapped > Math.PI) wrapped -= Math.PI * 2;
  if (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}
