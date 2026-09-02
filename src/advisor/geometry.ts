/**
 * Geometry the advisor and the generator both need.
 *
 * None of this is design knowledge — it is the measuring tape. It answers
 * questions like "which wall of this room is the longest blank stretch",
 * "where would a 2.28 m sofa sit against it", and "is this position actually
 * legal" — so that `rules.ts` and `generate.ts` can be about interiors rather
 * than about trigonometry.
 *
 * THE ROTATION CONVENTION, once, because getting it wrong is subtle and awful:
 * a piece's rotation r means it FACES the direction (-sin r, cos r). At r = 0 a
 * piece faces +Z. To make a piece face a direction d, use `rotationFacing(d)`.
 * This is the same convention `snapToWall` uses, and a sign error here seats
 * sofas facing the wall — which looks nearly right in a still image and is
 * completely wrong to sit in.
 */

import {
  distance,
  indexVertices,
  normalize,
  resolveWall,
  type Region,
  type WallSegment,
} from '@/scene/planGraph';
import { obbCorners, obbIntersects, pointInPolygon, type Collider, type Obb } from '@/physics/collision';
import { collidersFor, itemFootprint, wallColliders } from '@/physics/colliders';
import { getCatalogEntry } from '@/furniture/catalog';
import { furnitureZones, openingZones, type ClearanceZone } from '@/clearance/zones';
import type { DesignDocument, FurnitureItem, PlanModel, Point2 } from '@/state/types';

/* ------------------------------- Angles -------------------------------- */

/** The direction a piece at this rotation faces. */
export function forwardOf(rotation: number): Point2 {
  return { x: -Math.sin(rotation), z: Math.cos(rotation) };
}

/** The direction a piece at this rotation's right-hand side points. */
export function rightOf(rotation: number): Point2 {
  return { x: Math.cos(rotation), z: Math.sin(rotation) };
}

/** The rotation that makes a piece face `direction`. */
export function rotationFacing(direction: Point2): number {
  return Math.atan2(-direction.x, direction.z);
}

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(radians: number): number {
  let a = radians;
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

/** Smallest absolute angle between two headings, 0 to PI. */
export function angleBetween(a: number, b: number): number {
  return Math.abs(wrapAngle(a - b));
}

/**
 * Smallest angle between two headings treated as UNDIRECTED lines, 0 to PI/2.
 *
 * Two sofas back to back are parallel even though their headings differ by
 * 180 degrees, so alignment checks care about the line, not the arrow.
 */
export function axisAngleBetween(a: number, b: number): number {
  const diff = angleBetween(a, b);
  return diff > Math.PI / 2 ? Math.PI - diff : diff;
}

export function add(a: Point2, b: Point2): Point2 {
  return { x: a.x + b.x, z: a.z + b.z };
}

export function scale(v: Point2, k: number): Point2 {
  return { x: v.x * k, z: v.z * k };
}

export function dot(a: Point2, b: Point2): number {
  return a.x * b.x + a.z * b.z;
}

/* ----------------------------- Room walls ------------------------------ */

/** A span along a wall, measured from the wall's start vertex. */
export interface Span {
  from: number;
  to: number;
}

export function spanLength(span: Span): number {
  return span.to - span.from;
}

/**
 * One bounding wall of a room, seen from inside that room.
 *
 * The important transformation here is from the wall's CENTRELINE (which is
 * what the plan stores) to its INTERIOR FACE (which is what furniture actually
 * stands against). Half the wall's thickness is not a rounding error: a 15 cm
 * wall puts a bookcase 7.5 cm into the plaster if you ignore it.
 */
export interface RoomWall {
  wallId: string;
  segment: WallSegment;
  /** Unit vector pointing from the wall into this room. */
  inward: Point2;
  /** Start of the wall's interior face. */
  faceStart: Point2;
  faceEnd: Point2;
  length: number;
  /** Rotation for a piece standing against this wall, facing into the room. */
  seatRotation: number;
  /** Spans occupied by doors and windows, along the wall from its start. */
  openingSpans: Span[];
  /** Whether any window pierces this wall — matters for beds and desks. */
  hasWindow: boolean;
  hasDoor: boolean;
}

/**
 * The bounding walls of a room, resolved and oriented inwards.
 *
 * `region.facing` already says which face of each wall looks into the room, so
 * the inward normal is a sign flip rather than a geometric test — which matters
 * for a shared wall between two rooms, where "inward" is genuinely different
 * depending on which side you are standing on.
 */
export function roomWalls(plan: PlanModel, region: Region): RoomWall[] {
  const vertices = indexVertices(plan);
  const byId = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const result: RoomWall[] = [];

  for (const wallId of region.wallIds) {
    const wall = byId.get(wallId);
    if (!wall) continue;
    const segment = resolveWall(wall, vertices);
    if (!segment) continue;

    // Face "a" is the side the wall's normal points to; the region records
    // which face looks into it.
    const sign = region.facing[wallId] === 'a' ? 1 : -1;
    const inward = scale(segment.normal, sign);
    const offset = scale(inward, wall.thickness / 2);

    const openingSpans: Span[] = [];
    let hasWindow = false;
    let hasDoor = false;
    for (const opening of wall.openings) {
      openingSpans.push({
        from: opening.offset - opening.width / 2,
        to: opening.offset + opening.width / 2,
      });
      if (opening.kind === 'window') hasWindow = true;
      else hasDoor = true;
    }
    openingSpans.sort((a, b) => a.from - b.from);

    result.push({
      wallId,
      segment,
      inward,
      faceStart: add(segment.start, offset),
      faceEnd: add(segment.end, offset),
      length: segment.length,
      seatRotation: rotationFacing(inward),
      openingSpans,
      hasWindow,
      hasDoor,
    });
  }

  return result;
}

/**
 * Stretches of a wall with no opening in them.
 *
 * `margin` shrinks each end, which keeps a wardrobe from being wedged into a
 * corner it cannot be opened in and keeps a sofa from being jammed against the
 * return wall. Spans shorter than `minLength` are dropped as unusable.
 */
export function blankSpans(wall: RoomWall, margin = 0.05, minLength = 0.3): Span[] {
  const spans: Span[] = [];
  let cursor = margin;

  const emit = (from: number, to: number) => {
    if (to - from >= minLength) spans.push({ from, to });
  };

  for (const opening of wall.openingSpans) {
    // A door needs the floor beside it kept clear too, but that is the
    // clearance system's job; here we only avoid standing furniture in the
    // hole itself.
    emit(cursor, Math.min(opening.from, wall.length - margin));
    cursor = Math.max(cursor, opening.to);
  }
  emit(cursor, wall.length - margin);

  return spans.filter((span) => span.to > span.from);
}

/** A point on a wall's interior face, `t` metres from the wall's start. */
export function pointOnFace(wall: RoomWall, t: number): Point2 {
  const clamped = Math.max(0, Math.min(wall.length, t));
  const dir = normalize({ x: wall.faceEnd.x - wall.faceStart.x, z: wall.faceEnd.z - wall.faceStart.z });
  return add(wall.faceStart, scale(dir, clamped));
}

/**
 * Where a piece of the given half-depth sits when placed against a wall.
 *
 * `t` is along the wall from its start; the result is the piece's CENTRE, one
 * half-depth off the interior face plus a contact gap.
 */
export function seatAgainst(wall: RoomWall, t: number, halfDepth: number, gap = 0.01): Point2 {
  return add(pointOnFace(wall, t), scale(wall.inward, halfDepth + gap));
}

/* ------------------------------ Room frame ----------------------------- */

/**
 * A room's own axes.
 *
 * Rooms are not always drawn parallel to the world grid, and a generator that
 * assumed they were would lay a bedroom out diagonally across a room drawn at
 * 30 degrees. The longest wall defines the grain; everything else is expressed
 * relative to it.
 */
export interface RoomFrame {
  /** Heading of the longest wall, in radians. */
  angle: number;
  /** Room centre — a point guaranteed to be inside it. */
  center: Point2;
  /** Extent along the grain. */
  spanAlong: number;
  /** Extent across it. */
  spanAcross: number;
  /** The shorter of the two, which is what "will it fit" usually means. */
  shortSpan: number;
}

export function roomFrame(plan: PlanModel, region: Region): RoomFrame {
  const walls = roomWalls(plan, region);
  let angle = 0;
  let longest = -1;
  for (const wall of walls) {
    if (wall.length > longest) {
      longest = wall.length;
      angle = Math.atan2(wall.segment.direction.z, wall.segment.direction.x);
    }
  }

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;

  for (const point of region.polygon) {
    const along = point.x * cos + point.z * sin;
    const across = -point.x * sin + point.z * cos;
    minAlong = Math.min(minAlong, along);
    maxAlong = Math.max(maxAlong, along);
    minAcross = Math.min(minAcross, across);
    maxAcross = Math.max(maxAcross, across);
  }

  const spanAlong = maxAlong - minAlong;
  const spanAcross = maxAcross - minAcross;

  return {
    angle,
    center: region.interiorPoint,
    spanAlong,
    spanAcross,
    shortSpan: Math.min(spanAlong, spanAcross),
  };
}

/** How far a point is from the nearest wall of a room. */
export function distanceToWalls(point: Point2, region: Region): number {
  let best = Infinity;
  const polygon = region.polygon;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!;
    const b = polygon[i]!;
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const lengthSq = abx * abx + abz * abz;
    const t =
      lengthSq < 1e-12
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.z - a.z) * abz) / lengthSq));
    best = Math.min(best, distance(point, { x: a.x + abx * t, z: a.z + abz * t }));
  }
  return best;
}

/** How far a placed piece's nearest edge is from the room's walls. */
export function itemWallGap(item: FurnitureItem, region: Region): number {
  let best = Infinity;
  for (const corner of obbCorners(itemFootprint(item))) {
    best = Math.min(best, distanceToWalls(corner, region));
  }
  return best;
}

/* ----------------------------- Legality -------------------------------- */

/**
 * Tests whether a position for a piece is one the app would have allowed.
 *
 * The advisor and the generator must never produce a layout a person could not
 * have dragged into place themselves — a fix that buries a sofa in a wall is
 * worse than no fix at all. So legality is tested against the same colliders
 * the drag path uses, plus room containment, plus (optionally) the required
 * clearance zones that strict mode enforces.
 *
 * Built as a small class rather than a function because the generator tests
 * hundreds of candidate positions per slot, and rebuilding the wall colliders
 * for each of them turns a snappy operation into a visible pause.
 */
export class Placer {
  private wallColliders: Collider[];
  /** Colliders for the furniture already placed, by item ID for exclusion. */
  private items: Collider[] = [];
  private openingZones: ClearanceZone[];

  constructor(
    private plan: PlanModel,
    furniture: readonly FurnitureItem[],
    private options: { respectClearance?: boolean } = {},
  ) {
    this.wallColliders = wallColliders(plan);
    this.openingZones = openingZones(plan);
    this.setFurniture(furniture);
  }

  /** Refreshes the furniture colliders after something has been placed. */
  setFurniture(furniture: readonly FurnitureItem[]): void {
    this.items = [];
    for (const item of furniture) {
      // Rugs lie flat; everything stands on top of them.
      if (getCatalogEntry(item.catalogId).layer === 'floor') continue;
      this.items.push({ kind: 'furniture', id: item.id, ...itemFootprint(item) });
    }
  }

  /**
   * True when a box of this size, here, at this angle, is a legal place to be.
   *
   * `exclude` names items to ignore — the piece being moved, and anything the
   * caller has already decided to remove.
   */
  fits(
    box: Obb,
    region: Region,
    options: { exclude?: ReadonlySet<string>; isRug?: boolean; padding?: number } = {},
  ): boolean {
    const padding = options.padding ?? 0.002;

    if (!obbCornersInside(box, region)) return false;

    for (const collider of this.wallColliders) {
      if (obbIntersects(box, collider, padding)) return false;
    }

    // A rug only has to stay off the walls.
    if (!options.isRug) {
      for (const collider of this.items) {
        if (options.exclude?.has(collider.id)) continue;
        if (obbIntersects(box, collider, padding)) return false;
      }

      if (this.options.respectClearance) {
        for (const zone of this.openingZones) {
          if (obbIntersects(box, zone, 0)) return false;
        }
      }
    }

    return true;
  }

  /** The plan this placer was built for, for callers that need it back. */
  get planModel(): PlanModel {
    return this.plan;
  }
}

/** Every corner of a box lies inside a room. */
export function obbCornersInside(box: Obb, region: Region): boolean {
  for (const corner of obbCorners(box)) {
    if (!pointInPolygon(corner, region.polygon)) return false;
  }
  return true;
}

/**
 * Legality for a single hypothetical move, without building a Placer.
 *
 * Used by the rule engine, which tests one or two candidate positions per
 * finding rather than hundreds, and wants the answer to match exactly what
 * `moveFurniture` would do.
 */
export function positionIsLegal(
  doc: DesignDocument,
  region: Region,
  itemId: string | null,
  box: Obb,
  isRug: boolean,
): boolean {
  if (!obbCornersInside(box, region)) return false;
  const colliders = isRug ? wallColliders(doc.plan) : collidersFor(doc.plan, doc.furniture, itemId);
  for (const collider of colliders) {
    if (obbIntersects(box, collider, 0.002)) return false;
  }
  return true;
}

/* ------------------------------ Occupancy ------------------------------ */

/**
 * Zones already spoken for in a room: furniture footprints and door swings.
 *
 * The generator uses this to avoid parking a lamp exactly where a door opens,
 * which is legal by collision but wrong by any other measure.
 */
export function reservedZones(doc: DesignDocument): ClearanceZone[] {
  return [...openingZones(doc.plan), ...furnitureZones(doc.furniture)];
}

/** Centre-to-centre distance between two placed pieces. */
export function itemDistance(a: FurnitureItem, b: FurnitureItem): number {
  return distance({ x: a.x, z: a.z }, { x: b.x, z: b.z });
}

/**
 * The gap between two pieces' nearest edges, approximately.
 *
 * Exact edge-to-edge distance between two oriented boxes needs a full
 * separating-axis sweep; for advice, projecting the centre-line separation onto
 * each box's own extent is accurate to a couple of centimetres and is what a
 * tape measure held between two sofas would read.
 */
export function edgeGap(a: Obb, b: Obb): number {
  const delta = { x: b.center.x - a.center.x, z: b.center.z - a.center.z };
  const span = Math.hypot(delta.x, delta.z);
  if (span < 1e-9) return -Math.min(a.halfWidth, a.halfDepth) * 2;
  const axis = { x: delta.x / span, z: delta.z / span };
  return span - extentAlong(a, axis) - extentAlong(b, axis);
}

/** How far a box reaches from its centre along an axis. */
export function extentAlong(box: Obb, axis: Point2): number {
  const cos = Math.cos(box.rotation);
  const sin = Math.sin(box.rotation);
  const localX = { x: cos, z: sin };
  const localZ = { x: -sin, z: cos };
  return (
    Math.abs(dot(localX, axis)) * box.halfWidth + Math.abs(dot(localZ, axis)) * box.halfDepth
  );
}

/** The point on a piece's front face, at its centre. */
export function frontCenter(box: Obb): Point2 {
  return add(box.center, scale(forwardOf(box.rotation), box.halfDepth));
}

/* ---------------------------- Table perimeter -------------------------- */

/**
 * Evenly spaced chair positions around a table, in the table's own frame.
 *
 * Shared by the dining rule (which uses it to tidy a scattered set) and the
 * generator (which uses it to lay one out from scratch), so that "set the
 * chairs round the table" means exactly the same arrangement whether you asked
 * the advisor to fix it or asked the generator to build it.
 *
 * Long sides first, then the ends, and only where the table is deep enough for
 * somebody to sit at the end without their knees meeting the person opposite.
 * 60 cm per person is the standard place setting.
 */
export function tablePerimeterSlots(
  table: Obb,
  chairDepth: number,
): Array<{ at: Point2; rotation: number }> {
  const cos = Math.cos(table.rotation);
  const sin = Math.sin(table.rotation);
  // The table's own axes, in world space.
  const localX = { x: cos, z: sin };
  const localZ = { x: -sin, z: cos };

  const slots: Array<{ at: Point2; rotation: number }> = [];
  const perSide = Math.max(1, Math.floor((table.halfWidth * 2) / 0.6));

  for (const sign of [1, -1]) {
    for (let i = 0; i < perSide; i++) {
      const along = ((i + 0.5) / perSide - 0.5) * table.halfWidth * 2;
      const outward = scale(localZ, sign);
      slots.push({
        at: add(
          add(table.center, scale(localX, along)),
          scale(outward, table.halfDepth + chairDepth + 0.02),
        ),
        // A chair faces the table, so its front points back inwards.
        rotation: rotationFacing(scale(outward, -1)),
      });
    }
  }

  if (table.halfDepth * 2 >= 0.9) {
    for (const sign of [1, -1]) {
      const outward = scale(localX, sign);
      slots.push({
        at: add(table.center, scale(outward, table.halfWidth + chairDepth + 0.02)),
        rotation: rotationFacing(scale(outward, -1)),
      });
    }
  }

  return slots;
}
