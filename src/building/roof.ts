/**
 * Building a roof from a plan.
 *
 * The straight skeleton (see `skeleton.ts`) does the hard part: it says where
 * the ridges, hips and valleys go and how far every point is from its own eave.
 * This module turns that into a roof — which means answering the questions the
 * skeleton does not care about:
 *
 *   • Where does the eave line actually run? Past the outside of the walls, by
 *     the overhang, with each wall's own thickness respected.
 *   • How high is the eave? On top of the wall plate of the storey below.
 *   • What SHAPE of roof? A hip is the skeleton unmodified. A gable is the same
 *     solve with the gabled eaves held still, which drops the plane over them
 *     and leaves a triangle of wall instead. A shed and a flat roof are one
 *     plane falling one way, and share their code because they are the same
 *     thing at different pitches.
 *
 * The output is planes in three dimensions, plus the gable walls, plus the
 * ridge lines for drawing. Nothing here is stored: a roof is rebuilt from the
 * walls every time, so it cannot drift out of step with the house.
 */

import { eaveOutline, footprintFor, type Footprint } from './footprint';
import {
  offsetPolygonEdges,
  prepare,
  signedArea,
  straightSkeleton,
  type SkeletonFace,
} from './skeleton';
import { elevationOf, levelById } from '@/state/levels';
import type { DesignDocument, Point2, Roof } from '@/state/types';

/** A point in the world. Y is up, as everywhere else. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One flat surface of the roof, rising from one eave. */
export interface RoofPlane {
  /** Which edge of the eave outline it rises from. */
  edgeIndex: number;
  /** The walls under that eave. */
  wallIds: string[];
  /** Outline, anticlockwise seen from above, eave first. */
  points: Vec3[];
  /** Unit normal, pointing up and out of the roof. */
  normal: Vec3;
  /** Footprint area, in square metres — what the plan drawing shows. */
  planArea: number;
  /** True surface area, which is what you buy shingles by. */
  slopedArea: number;
}

/**
 * The triangle (or trapezium) of wall under a gable.
 *
 * Part of the WALL, not the roof, and rendered and priced as such — but it only
 * exists because of the roof's shape, so it is worked out here.
 */
export interface GableWall {
  edgeIndex: number;
  wallIds: string[];
  /** Outline of the vertical panel, from one eave end round to the other. */
  points: Vec3[];
  /** Height above the eave at the highest point, in metres. */
  peak: number;
}

export type RoofEdgeKind = 'ridge' | 'hip' | 'valley' | 'eave' | 'rake';

/** A line on the roof, for drawing and for flashing takeoffs later. */
export interface RoofEdge {
  from: Vec3;
  to: Vec3;
  kind: RoofEdgeKind;
}

export interface RoofGeometry {
  roofId: string;
  /** The eave outline in plan, anticlockwise. */
  eaves: Point2[];
  /**
   * The outside face of the walls, in plan, aligned with `eaves`.
   *
   * The strip between the two is the SOFFIT — the underside of the overhang.
   * Without it a roof is a lid held up over nothing, and from any angle below
   * the eaves you look straight up into an unlit void where the ceiling of the
   * overhang should be. It is one of those details nobody notices until it is
   * missing, at which point the whole building looks unfinished.
   */
  wallLine: Point2[];
  /** Height of the eave line above the site datum, in metres. */
  eaveHeight: number;
  /** Height of the highest point above the eave line, in metres. */
  rise: number;
  planes: RoofPlane[];
  gables: GableWall[];
  edges: RoofEdge[];
  /**
   * What went wrong, in plain words.
   *
   * A roof that cannot be built is reported rather than approximated. A roof
   * that is subtly wrong is far more dangerous than one that is visibly absent,
   * because only one of them gets noticed before it is built.
   */
  problems: string[];
}

/* ------------------------------ Building it ------------------------------ */

/**
 * Works out the roof over one storey.
 *
 * Returns null only when there is no storey to sit on; every other failure
 * comes back as a geometry with `problems` filled in, so the UI can say what is
 * wrong instead of showing nothing and leaving the user to guess.
 */
export function roofGeometry(doc: DesignDocument, roof: Roof): RoofGeometry | null {
  const level = levelById(doc, roof.overLevelId);
  if (!level) return null;

  const problems: string[] = [];
  const footprint = footprintFor(level, roof.anchorWallId);

  const empty = (): RoofGeometry => ({
    roofId: roof.id,
    eaves: [],
    wallLine: [],
    eaveHeight: 0,
    rise: 0,
    planes: [],
    gables: [],
    edges: [],
    problems,
  });

  if (!footprint) {
    problems.push(
      'No enclosed outline on this storey, so there is nothing for a roof to sit on. Close the walls into a loop first.',
    );
    return empty();
  }

  const eaves = prepare(eaveOutline(footprint, roof.overhang));
  if (eaves.length < 3) {
    problems.push('The eave line comes out tangled — usually an overhang wider than the building.');
    return empty();
  }
  if (eaves.length !== footprint.outline.length) {
    // The offset changed the corner count, so nothing downstream can be sure
    // which eave belongs to which wall.
    problems.push('The overhang is too deep for a corner of this plan; reduce it.');
    return empty();
  }

  // The eave sits on the wall plate. Where walls differ in height the tallest
  // decides, since the plate is one line all the way round.
  const plate = footprint.wallHeight.reduce((tallest, height) => Math.max(tallest, height), 0);
  const eaveHeight = elevationOf(doc, level.id) + (plate > 0 ? plate : level.wallHeight);

  // The wall face, for the soffit. Offset from the same centreline as the
  // eaves so the two outlines have the same corners in the same order.
  const wallLine = offsetPolygonEdges(footprint.outline, footprint.halfThickness);

  const geometry =
    roof.kind === 'shed' || roof.kind === 'flat'
      ? singlePlane(roof, footprint, eaves, eaveHeight, problems)
      : skeletonRoof(roof, footprint, eaves, eaveHeight, problems);

  return { ...(geometry ?? empty()), wallLine };
}

/* ----------------------------- Hips and gables ---------------------------- */

function skeletonRoof(
  roof: Roof,
  footprint: Footprint,
  eaves: Point2[],
  eaveHeight: number,
  problems: string[],
): RoofGeometry {
  const pitch = roof.pitch;

  /*
   * Which eaves are gabled.
   *
   * A gabled eave is held still — weight zero — so no plane grows from it and
   * the planes either side meet in a ridge above it. With none named, the app
   * picks the ends: run the hip first and gable every eave whose plane came out
   * a triangle. Those are exactly the hip ends, which is what a person means by
   * "make it a gable roof", and it gives the right answer on an L or a T where
   * "the two short sides" does not.
   */
  let gabled = new Set<number>();
  if (roof.kind === 'gable') {
    gabled =
      roof.gableWallIds.length > 0
        ? namedGables(footprint, roof.gableWallIds)
        : hipEnds(eaves);

    if (gabled.size > 0 && eaves.length - gabled.size < 2) {
      problems.push(
        'Gabling every side leaves nothing to slope; at least two eaves have to carry the roof. Showing it hipped instead.',
      );
      gabled = new Set();
    }
  }

  const weights = eaves.map((_, index) => (gabled.has(index) ? 0 : 1));
  const solved = straightSkeleton(eaves, weights);

  if (!solved.complete) {
    problems.push(
      'This outline defeated the roof solver, so part of the roof is missing. A simpler outline, or a flat or shed roof, will work.',
    );
  }

  const planes: RoofPlane[] = [];
  const gables: GableWall[] = [];

  for (const face of solved.faces) {
    if (gabled.has(face.edgeIndex)) {
      const wall = gableFrom(face, footprint, eaveHeight, pitch);
      if (wall) gables.push(wall);
      continue;
    }
    const plane = planeFrom(face, footprint, eaveHeight, pitch);
    if (plane) planes.push(plane);
  }

  const rise = planes.reduce(
    (highest, plane) =>
      Math.max(highest, ...plane.points.map((point) => point.y - eaveHeight)),
    0,
  );

  return {
    roofId: roof.id,
    eaves,
    wallLine: [],
    eaveHeight,
    rise,
    planes,
    gables,
    edges: classifyEdges(solved, eaves, eaveHeight, pitch, gabled),
    problems,
  };
}

/** The eaves named by a roof's gable list, as indices into the eave outline. */
function namedGables(footprint: Footprint, wallIds: readonly string[]): Set<number> {
  const wanted = new Set(wallIds);
  const gabled = new Set<number>();
  footprint.wallIds.forEach((ids, index) => {
    if (ids.some((id) => wanted.has(id))) gabled.add(index);
  });
  return gabled;
}

/**
 * The eaves that would be hip ends, found by hipping the roof and looking.
 *
 * A hip end is a plane that comes to a point: three corners, one of them at the
 * ridge. Every other plane runs into a ridge along a line and has four or more.
 */
function hipEnds(eaves: readonly Point2[]): Set<number> {
  const hipped = straightSkeleton(eaves);
  const ends = new Set<number>();
  if (!hipped.complete) return ends;

  for (const face of hipped.faces) {
    if (face.points.length === 3) ends.add(face.edgeIndex);
  }
  return ends;
}

/** Lifts one skeleton face into a sloping plane. */
function planeFrom(
  face: SkeletonFace,
  footprint: Footprint,
  eaveHeight: number,
  pitch: number,
): RoofPlane | null {
  const points = face.points.map((entry) => ({
    x: entry.at.x,
    y: eaveHeight + entry.time * pitch,
    z: entry.at.z,
  }));
  if (points.length < 3) return null;

  const planArea = Math.abs(signedArea(face.points.map((entry) => entry.at)));
  if (planArea < 1e-9) return null;

  /*
   * The slope factor is the same for every plane on the roof — that is what one
   * pitch MEANS — so the true area is the plan area stretched by it. Measuring
   * the three-dimensional polygon instead would give the same answer with more
   * arithmetic and more chances to be wrong.
   */
  const slope = Math.hypot(1, pitch);

  return {
    edgeIndex: face.edgeIndex,
    wallIds: footprint.wallIds[face.edgeIndex] ?? [],
    points,
    normal: normalOf(face, pitch),
    planArea,
    slopedArea: planArea * slope,
  };
}

/**
 * Lifts a held-still eave into the gable wall above it.
 *
 * The face for a gabled eave has no area in plan — every point of it sits on
 * the eave line — but its heights are real, and they are the profile of the
 * wall that has to be built up to meet the roof.
 */
function gableFrom(
  face: SkeletonFace,
  footprint: Footprint,
  eaveHeight: number,
  pitch: number,
): GableWall | null {
  if (face.points.length < 3) return null;

  const points = face.points.map((entry) => ({
    x: entry.at.x,
    y: eaveHeight + entry.time * pitch,
    z: entry.at.z,
  }));

  return {
    edgeIndex: face.edgeIndex,
    wallIds: footprint.wallIds[face.edgeIndex] ?? [],
    points,
    peak: Math.max(...points.map((point) => point.y)) - eaveHeight,
  };
}

/** Unit normal of a plane rising from one eave at a given pitch. */
function normalOf(face: SkeletonFace, pitch: number): Vec3 {
  const eaveA = face.points[0]!.at;
  const eaveB = face.points[1]!.at;
  const along = { x: eaveB.x - eaveA.x, z: eaveB.z - eaveA.z };
  const len = Math.hypot(along.x, along.z) || 1;

  // Inward horizontal normal of the eave: the direction the plane climbs.
  const uphill = { x: -along.z / len, z: along.x / len };
  // Rising one in `pitch` along that direction tips the normal back by the same.
  const scale = Math.hypot(1, pitch);
  return { x: -uphill.x * pitch / scale, y: 1 / scale, z: -uphill.z * pitch / scale };
}

/* ------------------------------ Sheds and flats --------------------------- */

/**
 * One plane, falling from a high side to a low one.
 *
 * A flat roof is the same object at a shallower angle, and shares this code
 * deliberately: a "flat" roof still falls, or it ponds and then it leaks. IRC
 * R905 sets the minimum for each covering and `code/roof.ts` checks it; here
 * the only difference between the two is which pitches the UI offers.
 */
function singlePlane(
  roof: Roof,
  footprint: Footprint,
  eaves: Point2[],
  eaveHeight: number,
  problems: string[],
): RoofGeometry {
  const lowIndex = lowSideOf(footprint, eaves, roof.lowWallId);
  const from = eaves[lowIndex]!;
  const to = eaves[(lowIndex + 1) % eaves.length]!;

  const along = { x: to.x - from.x, z: to.z - from.z };
  const len = Math.hypot(along.x, along.z);
  if (len < 1e-9) {
    problems.push('The low side of the roof has no length; the plan needs a look.');
  }

  // Inward normal of the low eave: the direction the roof climbs.
  const uphill = len > 1e-9 ? { x: -along.z / len, z: along.x / len } : { x: 0, z: 1 };
  const heightAt = (point: Point2) =>
    eaveHeight +
    Math.max(0, (point.x - from.x) * uphill.x + (point.z - from.z) * uphill.z) * roof.pitch;

  const points = eaves.map((point) => ({ x: point.x, y: heightAt(point), z: point.z }));
  const planArea = Math.abs(signedArea(eaves));
  const slope = Math.hypot(1, roof.pitch);

  const scale = slope;
  const normal: Vec3 = {
    x: -uphill.x * roof.pitch / scale,
    y: 1 / scale,
    z: -uphill.z * roof.pitch / scale,
  };

  const edges: RoofEdge[] = eaves.map((point, index) => {
    const next = eaves[(index + 1) % eaves.length]!;
    return {
      from: { x: point.x, y: heightAt(point), z: point.z },
      to: { x: next.x, y: heightAt(next), z: next.z },
      // The two sides that climb are rakes; the top and bottom are eaves.
      kind: rakeOrEave(heightAt(point), heightAt(next), eaveHeight),
    };
  });

  return {
    roofId: roof.id,
    eaves,
    wallLine: [],
    eaveHeight,
    rise: Math.max(...points.map((point) => point.y)) - eaveHeight,
    planes: [
      {
        edgeIndex: lowIndex,
        wallIds: footprint.wallIds[lowIndex] ?? [],
        points,
        normal,
        planArea,
        slopedArea: planArea * slope,
      },
    ],
    gables: [],
    edges,
    problems,
  };
}

function rakeOrEave(fromY: number, toY: number, eaveHeight: number): RoofEdgeKind {
  const level = Math.abs(fromY - toY) < 1e-6;
  if (level) return Math.abs(fromY - eaveHeight) < 1e-6 ? 'eave' : 'ridge';
  return 'rake';
}

/**
 * Which eave a shed roof falls to.
 *
 * Named by the user if they have said; otherwise the longest side, because a
 * shed roof normally falls off the long face of a building — that is the one
 * whose gutter can take the water, and the one that keeps the rise sensible.
 */
function lowSideOf(
  footprint: Footprint,
  eaves: readonly Point2[],
  lowWallId: string | null,
): number {
  if (lowWallId) {
    const named = footprint.wallIds.findIndex((ids) => ids.includes(lowWallId));
    if (named >= 0 && named < eaves.length) return named;
  }

  let best = 0;
  let longest = -1;
  for (let i = 0; i < eaves.length; i++) {
    const here = eaves[i]!;
    const next = eaves[(i + 1) % eaves.length]!;
    const span = Math.hypot(next.x - here.x, next.z - here.z);
    if (span > longest) {
      longest = span;
      best = i;
    }
  }
  return best;
}

/* -------------------------------- The lines ------------------------------- */

/**
 * Sorts the skeleton's arcs into ridges, hips and valleys.
 *
 * Not decoration. A roofer prices these separately — ridge and hip get capping,
 * a valley gets flashing and is where the roof leaks if it is done badly — and
 * the drawing set has to label them. The classification is geometric:
 *
 *   • Both ends at the same height, above the eave: a RIDGE.
 *   • One end down at the eave, rising from an OUTSIDE corner: a HIP.
 *   • One end down at the eave, rising from an INSIDE corner: a VALLEY.
 *
 * The corner tells hip from valley, which is why the eave outline is needed
 * here and not only the arcs.
 */
function classifyEdges(
  solved: ReturnType<typeof straightSkeleton>,
  eaves: readonly Point2[],
  eaveHeight: number,
  pitch: number,
  gabled: ReadonlySet<number>,
): RoofEdge[] {
  const edges: RoofEdge[] = [];

  for (let i = 0; i < eaves.length; i++) {
    const here = eaves[i]!;
    const next = eaves[(i + 1) % eaves.length]!;
    // The bottom of a gable end carries nothing — no gutter, because no roof
    // drains onto it, and no barge board, because the roof is not there. It is
    // simply where the wall meets the floor of the storey below.
    if (gabled.has(i)) continue;

    edges.push({
      from: { x: here.x, y: eaveHeight, z: here.z },
      to: { x: next.x, y: eaveHeight, z: next.z },
      kind: 'eave',
    });
  }

  for (const arc of solved.arcs) {
    const fromY = eaveHeight + arc.fromTime * pitch;
    const toY = eaveHeight + arc.toTime * pitch;
    if (Math.hypot(arc.to.x - arc.from.x, arc.to.z - arc.from.z) < 1e-6) continue;

    /*
     * An arc bordering a gabled eave is that gable's RAKE — the sloping edge
     * the barge board runs along, from the eave corner up to the apex. It is
     * not the horizontal line at the bottom of the gable, which is what an
     * earlier version of this measured and which is neither an eave nor a rake.
     * The difference matters: a rake is longer than its plan run by the slope,
     * and somebody is going to buy timber by this number.
     */
    if (gabled.has(arc.left) || gabled.has(arc.right)) {
      edges.push({
        from: { x: arc.from.x, y: fromY, z: arc.from.z },
        to: { x: arc.to.x, y: toY, z: arc.to.z },
        kind: 'rake',
      });
      continue;
    }

    const lowEnd = Math.min(arc.fromTime, arc.toTime);
    let kind: RoofEdgeKind = 'ridge';
    if (lowEnd < 1e-6) {
      const corner = arc.fromTime < arc.toTime ? arc.from : arc.to;
      kind = isReflexCorner(corner, eaves) ? 'valley' : 'hip';
    }

    edges.push({
      from: { x: arc.from.x, y: fromY, z: arc.from.z },
      to: { x: arc.to.x, y: toY, z: arc.to.z },
      kind,
    });
  }

  return edges;
}

/** Whether the outline turns inwards at the corner nearest a point. */
function isReflexCorner(point: Point2, polygon: readonly Point2[]): boolean {
  let best = -1;
  let nearest = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const distance = Math.hypot(polygon[i]!.x - point.x, polygon[i]!.z - point.z);
    if (distance < nearest) {
      nearest = distance;
      best = i;
    }
  }
  if (best < 0 || nearest > 1e-4) return false;

  const count = polygon.length;
  const prev = polygon[(best - 1 + count) % count]!;
  const here = polygon[best]!;
  const next = polygon[(best + 1) % count]!;
  const cross =
    (here.x - prev.x) * (next.z - here.z) - (here.z - prev.z) * (next.x - here.x);
  // Anticlockwise outline: a negative turn is an inside corner.
  return cross < -1e-9;
}

/* -------------------------------- Queries -------------------------------- */

/**
 * How high the roof is above a point on the plan, or null if it is not covered.
 *
 * Used for placing dormers and skylights, for checking headroom in an attic,
 * and by anything that needs to know whether a point is under the roof at all.
 */
export function roofHeightAt(geometry: RoofGeometry, point: Point2): number | null {
  for (const plane of geometry.planes) {
    const outline = plane.points.map((vertex) => ({ x: vertex.x, z: vertex.z }));
    if (!pointInPolygon(point, outline)) continue;

    // Every plane is flat, so its height follows from any one of its corners
    // and its normal: n . (p - corner) = 0.
    const anchor = plane.points[0]!;
    if (Math.abs(plane.normal.y) < 1e-9) return anchor.y;
    return (
      anchor.y -
      (plane.normal.x * (point.x - anchor.x) + plane.normal.z * (point.z - anchor.z)) /
        plane.normal.y
    );
  }
  return null;
}

/** Which plane covers a point, if any. */
export function planeAt(geometry: RoofGeometry, point: Point2): RoofPlane | null {
  for (const plane of geometry.planes) {
    const outline = plane.points.map((vertex) => ({ x: vertex.x, z: vertex.z }));
    if (pointInPolygon(point, outline)) return plane;
  }
  return null;
}

/** Total area of covering the roof needs, in square metres. */
export function roofArea(geometry: RoofGeometry): number {
  return geometry.planes.reduce((total, plane) => total + plane.slopedArea, 0);
}

/** Plan area under the roof, which is what ventilation is worked out from. */
export function roofPlanArea(geometry: RoofGeometry): number {
  return geometry.planes.reduce((total, plane) => total + plane.planArea, 0);
}

function pointInPolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const straddles = a.z > point.z !== b.z > point.z;
    if (!straddles) continue;
    const crossing = ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
    if (point.x < crossing) inside = !inside;
  }
  return inside;
}
