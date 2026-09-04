/**
 * The ground the building stands on.
 *
 * Three things live here, and they are related more closely than they look:
 *
 *   THE GROUND SURFACE. Flat, a constant fall, or surveyed spot heights. Every
 *   height is relative to the finished ground floor, so a negative height is
 *   ground below the front door — which is the normal case, because a house
 *   sits up on its foundation.
 *
 *   THE PLOT. Its outline, which way is north, and how much of it may be built
 *   on once the setbacks are taken off.
 *
 *   WHAT IT COSTS TO BUILD ON. A sloping plot has to be cut and filled to give
 *   a level pad, and the volumes involved are the first real number in a
 *   groundworks estimate. They are also the number that tells somebody their
 *   lovely sloping site is going to be expensive, which is worth knowing before
 *   the design is finished rather than after.
 */

import { offsetPolygonEdges } from './skeleton';
import { footprintsOf } from './footprint';
import type { Level, Point2, Site, Terrain } from '@/state/types';

/**
 * The height of the ground at a point, in metres relative to the ground floor.
 *
 * Spot heights are interpolated by inverse-distance weighting rather than by
 * triangulating them. That is a deliberate trade: a triangulation gives the
 * exact plane between three surveyed points and is what a civil engineer would
 * use, but it is fragile at the edges of the data and undefined outside the
 * hull, which is exactly where a house corner tends to land. Weighting is
 * smooth, defined everywhere, and honest about being an interpolation. It is
 * good enough to see a slope and to estimate earthworks; it is not a survey.
 */
export function groundHeightAt(site: Site, point: Point2): number {
  const terrain = site.terrain;

  switch (terrain.kind) {
    case 'flat':
      return terrain.datum;

    case 'slope': {
      // `fallDirection` points downhill, so going that way loses height.
      const downhill = { x: Math.cos(terrain.fallDirection), z: Math.sin(terrain.fallDirection) };
      return terrain.datum - terrain.fall * (point.x * downhill.x + point.z * downhill.z);
    }

    case 'spots': {
      if (terrain.spots.length === 0) return terrain.datum;

      let weighted = 0;
      let weights = 0;
      for (const spot of terrain.spots) {
        const distance = Math.hypot(point.x - spot.at.x, point.z - spot.at.z);
        // Right on a surveyed point, take the surveyed height and stop: no
        // interpolation can improve on a measurement.
        if (distance < 1e-6) return spot.height;
        const weight = 1 / (distance * distance);
        weighted += spot.height * weight;
        weights += weight;
      }
      return weights > 0 ? weighted / weights : terrain.datum;
    }
  }
}

/** The steepest fall at a point, as a ratio, and the direction it falls in. */
export function groundSlopeAt(
  site: Site,
  point: Point2,
  sample = 0.5,
): { fall: number; direction: number } {
  const here = groundHeightAt(site, point);
  const east = groundHeightAt(site, { x: point.x + sample, z: point.z });
  const north = groundHeightAt(site, { x: point.x, z: point.z + sample });

  // The gradient, then the downhill direction, which is the other way.
  const dx = (east - here) / sample;
  const dz = (north - here) / sample;
  const fall = Math.hypot(dx, dz);

  return { fall, direction: Math.atan2(-dz, -dx) };
}

/* --------------------------------- The plot ------------------------------- */

/** Area of the plot, in square metres. Zero until a boundary is drawn. */
export function plotArea(site: Site): number {
  return Math.abs(shoelace(site.boundary));
}

/**
 * The part of the plot that may actually be built on.
 *
 * The boundary pulled in by the setback that applies to each edge. Which edge
 * is the front is remembered by a point on it rather than by its position in
 * the outline, so that redrawing the plot does not silently move the front of
 * the house to the back.
 *
 * Returns an empty outline when the setbacks eat the whole plot, which is a
 * real answer — some plots genuinely cannot be built on under their own
 * ordinance — rather than a failure.
 */
export function buildableArea(site: Site): Point2[] {
  const boundary = anticlockwise(site.boundary);
  if (boundary.length < 3) return [];

  const setbacks = site.setbacks;
  if (!setbacks) return boundary;

  const front = frontEdgeOf(boundary, setbacks.frontAt);
  const rear = (front + Math.floor(boundary.length / 2)) % boundary.length;

  const distances = boundary.map((_, index) => {
    if (index === front) return -setbacks.front;
    if (index === rear) return -setbacks.rear;
    return -setbacks.side;
  });

  const inset = offsetPolygonEdges(boundary, distances);
  return collapsed(boundary, inset) ? [] : inset;
}

/**
 * Whether an inset outline has eaten itself.
 *
 * Area is not the test, and this is the trap: pull all four sides of a square
 * in past the middle and what comes back is a smaller square, wound the same
 * way, with a perfectly respectable positive area — the shape has turned inside
 * out by rotating 180 degrees, which preserves orientation. The test that works
 * is per EDGE: an edge that now runs the other way has been overtaken by the
 * ones beside it, and the outline is no longer a shrunken version of anything.
 */
function collapsed(original: readonly Point2[], inset: readonly Point2[]): boolean {
  if (inset.length !== original.length || inset.length < 3) return true;

  for (let i = 0; i < original.length; i++) {
    const j = (i + 1) % original.length;
    const before = { x: original[j]!.x - original[i]!.x, z: original[j]!.z - original[i]!.z };
    const after = { x: inset[j]!.x - inset[i]!.x, z: inset[j]!.z - inset[i]!.z };
    if (before.x * after.x + before.z * after.z <= 1e-9) return true;
  }
  return false;
}

/** Which edge of the plot the user called the front. */
export function frontEdgeOf(boundary: readonly Point2[], frontAt: Point2 | null): number {
  if (!frontAt || boundary.length < 3) return 0;

  let best = 0;
  let nearest = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    const distance = distancePointSegment(
      frontAt,
      boundary[i]!,
      boundary[(i + 1) % boundary.length]!,
    );
    if (distance < nearest) {
      nearest = distance;
      best = i;
    }
  }
  return best;
}

/**
 * How much of the plot the building covers, as a fraction.
 *
 * Zoning ordinances cap this — "lot coverage" — far more often than people
 * expect, and it is the limit that quietly stops an extension. The figure is
 * the building's own footprint, not the roof's: coverage is normally measured
 * to the walls, though some ordinances count the eaves, which is why the number
 * is reported rather than judged.
 */
export function lotCoverage(site: Site, level: Level): number {
  const plot = plotArea(site);
  if (plot < 1e-9) return 0;

  const covered = footprintsOf(level).reduce(
    (total, footprint) => total + Math.abs(shoelace(footprint.outline)),
    0,
  );
  return covered / plot;
}

/* -------------------------------- Earthworks ------------------------------ */

export interface Earthworks {
  /** Volume to dig out to reach the pad level, in cubic metres. */
  cut: number;
  /** Volume to bring in, in cubic metres. */
  fill: number;
  /** Highest and lowest ground under the building, relative to the floor. */
  highest: number;
  lowest: number;
  /** The area the estimate covers, in square metres. */
  area: number;
}

/**
 * Roughly how much earth has to move to give the building a level pad.
 *
 * Sampled on a grid rather than integrated exactly, because the ground surface
 * is an interpolation to begin with and an exact integral of an approximation
 * is false precision. Half a metre is fine enough to see the shape of the
 * problem and coarse enough to stay quick on a big plot.
 *
 * The pad is the finished floor level, which is y = 0. In real life it sits a
 * little above the surrounding ground, and this deliberately does not model
 * that: it answers the question "what does this slope cost me", which is the
 * one worth asking at design time.
 */
export function earthworks(site: Site, level: Level, spacing = 0.5): Earthworks {
  const footprints = footprintsOf(level);
  const result: Earthworks = { cut: 0, fill: 0, highest: -Infinity, lowest: Infinity, area: 0 };
  if (footprints.length === 0) return { ...result, highest: 0, lowest: 0 };

  const cell = spacing * spacing;

  for (const footprint of footprints) {
    const outline = footprint.outline;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of outline) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }

    for (let x = minX + spacing / 2; x < maxX; x += spacing) {
      for (let z = minZ + spacing / 2; z < maxZ; z += spacing) {
        const point = { x, z };
        if (!pointInPolygon(point, outline)) continue;

        const ground = groundHeightAt(site, point);
        result.highest = Math.max(result.highest, ground);
        result.lowest = Math.min(result.lowest, ground);
        result.area += cell;

        // Ground above the pad has to come out; ground below it has to be
        // made up.
        if (ground > 0) result.cut += ground * cell;
        else result.fill += -ground * cell;
      }
    }
  }

  if (!Number.isFinite(result.highest)) {
    result.highest = 0;
    result.lowest = 0;
  }
  return result;
}

/* -------------------------------- The compass ----------------------------- */

/**
 * The compass bearing of a direction in the world, in degrees.
 *
 * The site stores the bearing of world +Z. Everything else — which way a window
 * faces, which slope of the roof will take the sun, which side of the house is
 * north — follows from that one number, and every drawing needs it.
 */
export function bearingOf(site: Site, direction: Point2): number {
  // Angle of the direction measured from +Z, turning towards +X, plus however
  // far +Z itself is from north.
  const fromZ = Math.atan2(direction.x, direction.z);
  const degrees = ((fromZ + site.northAngle) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

/** "NNE", "SW" — a bearing as the sixteen points of the compass. */
export function compassPoint(bearing: number): string {
  const points = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  const index = Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16;
  return points[index]!;
}

/** Which way a wall faces, as a compass point, given its outward normal. */
export function facingOf(site: Site, outwardNormal: Point2): string {
  return compassPoint(bearingOf(site, outwardNormal));
}

/* -------------------------------- Internals ------------------------------- */

/** A default terrain, for callers that need one without a document. */
export function flatTerrain(): Terrain {
  return { kind: 'flat', fall: 0, fallDirection: 0, spots: [], datum: 0 };
}

function shoelace(polygon: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const here = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    sum += here.x * next.z - next.x * here.z;
  }
  return sum / 2;
}

function anticlockwise(polygon: readonly Point2[]): Point2[] {
  const copy = polygon.map((point) => ({ x: point.x, z: point.z }));
  return shoelace(copy) < 0 ? copy.reverse() : copy;
}

function distancePointSegment(point: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < 1e-12) return Math.hypot(point.x - a.x, point.z - a.z);

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq));
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function pointInPolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.z > point.z === b.z > point.z) continue;
    const crossing = ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
    if (point.x < crossing) inside = !inside;
  }
  return inside;
}
