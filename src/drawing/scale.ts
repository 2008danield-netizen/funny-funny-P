/**
 * Drawing scales, and getting building coordinates onto a sheet of paper.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE.
 *
 * A drawing that says "1/4 in = 1 ft-0 in" in the title block and is not
 * actually at that scale is worse than a drawing with no scale on it at all —
 * somebody will put a rule on it. So there is exactly one place that converts
 * metres to points, exactly one place that names a scale, and the name and the
 * arithmetic come from the same object.
 *
 * -----------------------------------------------------------------------------
 * THE ARITHMETIC.
 *
 * A scale is a ratio: 1/4 in = 1 ft-0 in means one inch on paper is four feet
 * of building, which is 1:48. PDF measures in points at 72 to the inch, and the
 * model is in metres, so:
 *
 *     points per metre = 72 / (0.0254 × ratio)
 *
 * At 1:48 that is 59.06 points per metre — a 12 m house is 709 points across,
 * which fits a tabloid sheet with room for dimensions. That is not a
 * coincidence: it is why 1/4 in is the scale nearly every house plan is drawn
 * at.
 */

import type { Point2 } from '@/state/types';

/** Points in one metre at full size. */
const POINTS_PER_METRE = 72 / 0.0254;

export interface DrawingScale {
  id: string;
  /** How it is written on the drawing. */
  label: string;
  /** Metres of building per metre of paper. */
  ratio: number;
  /** Whether this is an imperial scale, which decides how it is written. */
  imperial: boolean;
}

/**
 * The scales a house is drawn at, largest first.
 *
 * Imperial ones are the architectural series everybody in the US works in;
 * metric ones are the equivalents everybody else does. They are interleaved by
 * ratio so that fitting a drawing to a sheet can walk the list once.
 */
export const SCALES: readonly DrawingScale[] = [
  { id: '1:20', label: '1:20', ratio: 20, imperial: false },
  { id: 'half-inch', label: '1/2 in = 1 ft-0 in', ratio: 24, imperial: true },
  { id: '1:25', label: '1:25', ratio: 25, imperial: false },
  { id: 'three-eighths', label: '3/8 in = 1 ft-0 in', ratio: 32, imperial: true },
  { id: '1:40', label: '1:40', ratio: 40, imperial: false },
  { id: 'quarter-inch', label: '1/4 in = 1 ft-0 in', ratio: 48, imperial: true },
  { id: '1:50', label: '1:50', ratio: 50, imperial: false },
  { id: 'three-sixteenths', label: '3/16 in = 1 ft-0 in', ratio: 64, imperial: true },
  { id: '1:75', label: '1:75', ratio: 75, imperial: false },
  { id: 'eighth-inch', label: '1/8 in = 1 ft-0 in', ratio: 96, imperial: true },
  { id: '1:100', label: '1:100', ratio: 100, imperial: false },
  { id: 'sixteenth-inch', label: '1/16 in = 1 ft-0 in', ratio: 192, imperial: true },
  { id: '1:200', label: '1:200', ratio: 200, imperial: false },
  { id: '1:500', label: '1:500', ratio: 500, imperial: false },
];

/** Points on the page for one metre of building at a given scale. */
export function pointsPerMetre(scale: DrawingScale): number {
  return POINTS_PER_METRE / scale.ratio;
}

/**
 * The largest standard scale at which a drawing of this size fits the frame.
 *
 * Standard, not arbitrary: a drawing at 1:63.7 fits perfectly and is useless,
 * because nobody owns a 1:63.7 rule. Falling off the end of the list returns
 * the smallest scale there is, and the caller's drawing simply runs off the
 * sheet — which is visible, unlike a silently wrong scale.
 */
export function fitScale(
  widthMetres: number,
  heightMetres: number,
  frameWidth: number,
  frameHeight: number,
  imperial: boolean,
): DrawingScale {
  const candidates = SCALES.filter((scale) => scale.imperial === imperial);
  const list = candidates.length > 0 ? candidates : SCALES;

  for (const scale of list) {
    const perMetre = pointsPerMetre(scale);
    if (widthMetres * perMetre <= frameWidth && heightMetres * perMetre <= frameHeight) {
      return scale;
    }
  }
  return list[list.length - 1]!;
}

/**
 * Maps a point in the building onto the page.
 *
 * TWO FLIPS HAPPEN HERE, and they are the whole reason this is a function
 * rather than a multiplication at each call site.
 *
 *   • The model's +Z runs SOUTH — down the screen in the plan view — while the
 *     page's +y runs UP. So z is negated.
 *   • The centre of the drawing is put at the centre of the frame, rather than
 *     the model's origin, so a plan drawn a hundred metres from the origin
 *     still lands on the paper.
 */
export interface Projector {
  scale: DrawingScale;
  perMetre: number;
  /** A point in the model, in metres, to a point on the page, in points. */
  at: (point: Point2) => { x: number; y: number };
  /** A length in metres to a length on the page. */
  length: (metres: number) => number;
}

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The bounding box of a set of points, in model coordinates. */
export function boundsOf(points: readonly Point2[]): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  width: number;
  depth: number;
} {
  if (points.length === 0) return { minX: 0, maxX: 0, minZ: 0, maxZ: 0, width: 0, depth: 0 };

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  return { minX, maxX, minZ, maxZ, width: maxX - minX, depth: maxZ - minZ };
}

/** A projector that centres the given model bounds in the given frame. */
export function projectorFor(
  scale: DrawingScale,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  frame: Frame,
): Projector {
  const perMetre = pointsPerMetre(scale);
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreZ = (bounds.minZ + bounds.maxZ) / 2;
  const originX = frame.x + frame.width / 2;
  const originY = frame.y + frame.height / 2;

  return {
    scale,
    perMetre,
    at: (point) => ({
      x: originX + (point.x - centreX) * perMetre,
      y: originY - (point.z - centreZ) * perMetre,
    }),
    length: (metres) => metres * perMetre,
  };
}
