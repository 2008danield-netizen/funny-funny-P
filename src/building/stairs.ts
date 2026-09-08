/**
 * Stair geometry.
 *
 * -----------------------------------------------------------------------------
 * THE ONE THING TO UNDERSTAND BEFORE EDITING THIS FILE.
 *
 * A staircase is not a shape you draw. It is a shape that FALLS OUT of one
 * number you cannot choose — the floor-to-floor rise — divided by one number
 * you can: how many steps you want to take. Everything else follows.
 *
 * So the riser height is never stored, only derived. A stair whose steps do not
 * sum to exactly the storey height has a short step at the top or the bottom,
 * and that step is the one people fall down: the body climbs stairs by rhythm,
 * not by looking, and it only notices the odd one when it is already committed.
 * The code says the same thing in its own way — no more than 3/8 in variation
 * across a whole flight (IRC R311.7.5.1).
 *
 * Derived also means a stair repairs itself. Raise a ground-floor ceiling and
 * the treads re-proportion; they do not quietly become wrong.
 * -----------------------------------------------------------------------------
 *
 * Everything here works in the stair's own frame — along the direction of
 * travel, and across it — and maps out to world XZ at the end. That is what
 * lets a stair drawn at 37 degrees to the world grid behave exactly like one
 * drawn square to it.
 */

import { inches } from '@/code/irc';
import { elevationOf, levelAbove, riseAbove } from '@/state/levels';
import type { Collider, Obb } from '@/physics/collision';
import type { DesignDocument, Point2, Stair, StairTurn } from '@/state/types';

/* ------------------------------- Local frame ------------------------------ */

/** Direction of travel for a given rotation. Matches the furniture convention. */
export function forwardOf(rotation: number): Point2 {
  return { x: -Math.sin(rotation), z: Math.cos(rotation) };
}

/** The right-hand side, looking along the direction of travel. */
export function rightOf(rotation: number): Point2 {
  return { x: Math.cos(rotation), z: Math.sin(rotation) };
}

/** A moving frame: where we are, and which way we are going. */
interface Cursor {
  origin: Point2;
  rotation: number;
}

/** Point at (along, across) in a cursor's frame. */
function place(cursor: Cursor, along: number, across: number): Point2 {
  const f = forwardOf(cursor.rotation);
  const r = rightOf(cursor.rotation);
  return {
    x: cursor.origin.x + f.x * along + r.x * across,
    z: cursor.origin.z + f.z * along + r.z * across,
  };
}

/** Turning right subtracts a quarter turn; left adds one. */
function turned(rotation: number, turn: StairTurn, quarters: number): number {
  return rotation + (turn === 'left' ? 1 : -1) * quarters * (Math.PI / 2);
}

/** +1 for a right turn, -1 for a left one — the sign of "across". */
function lateralSign(turn: StairTurn): number {
  return turn === 'right' ? 1 : -1;
}

/* --------------------------------- Treads --------------------------------- */

export type TreadKind = 'straight' | 'landing' | 'winder' | 'spiral';

/**
 * One walking surface, from the first step up to the floor above.
 *
 * `depthAtWalkline` is the measurement that matters and the one people get
 * wrong. On a straight tread it is simply the going. On a winder or a spiral it
 * is an arc length 12 in out from the narrow edge (IRC R311.7.5.2.1), which can
 * be far less than the depth at the middle of the same tread — which is why the
 * code says where to hold the tape.
 */
export interface Tread {
  /** 0 is the first tread you step onto, above the first riser. */
  index: number;
  kind: TreadKind;
  /** Walking surface height above the lower level's finished floor. */
  height: number;
  /** Plan outline, anticlockwise, in world XZ. */
  polygon: Point2[];
  /** Depth measured where feet actually go, in metres. */
  depthAtWalkline: number;
  /** Shallowest depth anywhere on the tread — the winder rule's second half. */
  minDepth: number;
  /** Midpoint of the nosing (leading edge), for headroom and handrail lines. */
  nosing: Point2;
}

/** Everything derived about one staircase. */
export interface StairGeometry {
  /** Floor-to-floor, in metres. Zero if there is no storey above. */
  totalRise: number;
  riserHeight: number;
  riserCount: number;
  treads: Tread[];
  /** Plan outline of the whole stair, anticlockwise, in world XZ. */
  footprint: Point2[];
  /**
   * The hole this stair needs in the floor above.
   *
   * Derived from HEADROOM, not from the footprint. The lower treads pass
   * comfortably under the ceiling and want solid floor over them; the opening
   * only has to begin where a person's head would otherwise meet the underside
   * of the storey above. Cutting the whole footprint out would throw away floor
   * area for nothing, and cutting none of it out would build a staircase into a
   * ceiling.
   */
  wellOpening: Point2[];
  /** Height of the walking line above the floor, per tread, for the handrail. */
  handrailLine: Array<{ at: Point2; height: number }>;
  /** True where the form makes a landing that must meet R311.7.6. */
  landings: Tread[];
}

/* ------------------------------- Construction ----------------------------- */

/**
 * Derives everything about a stair from the building it stands in.
 *
 * Pure: same document and stair in, same geometry out, no renderer involved.
 * That is what lets the code checks and the tests work on it directly.
 */
export function stairGeometry(doc: DesignDocument, stair: Stair): StairGeometry {
  const totalRise = riseAbove(doc, stair.fromLevelId);
  const riserCount = Math.max(2, Math.round(stair.riserCount));
  const riserHeight = totalRise > 0 ? totalRise / riserCount : 0;

  const treads: Tread[] = [];
  const landings: Tread[] = [];

  /*
   * A flight of N risers has N-1 treads. The last riser lands you on the floor
   * above, which is a floor rather than a step — an off-by-one here builds a
   * staircase with a spare tread sticking through the ceiling.
   */
  const treadCount = riserCount - 1;

  if (stair.form.kind === 'spiral') {
    buildSpiral(stair, stair.form, treadCount, riserHeight, treads);
  } else {
    buildRectilinear(stair, treadCount, riserHeight, treads, landings);
  }

  const footprint = outlineOf(stair, treads);
  const handrailLine = treads.map((tread) => ({
    at: tread.nosing,
    height: tread.height,
  }));

  return {
    totalRise,
    riserHeight,
    riserCount,
    treads,
    footprint,
    wellOpening: wellOpeningFor(doc, stair, treads, footprint),
    handrailLine,
    landings,
  };
}

/** Straight, L, U and winder stairs — everything made of flights and turns. */
function buildRectilinear(
  stair: Stair,
  treadCount: number,
  riserHeight: number,
  treads: Tread[],
  landings: Tread[],
): void {
  const width = stair.width;
  const going = stair.treadDepth;
  const form = stair.form;

  let cursor: Cursor = { origin: stair.at, rotation: stair.rotation };
  let index = 0;

  /** Emits `count` plain treads and advances the cursor past them. */
  const runStraight = (count: number) => {
    for (let i = 0; i < count && index < treadCount; i++) {
      const from = i * going;
      const to = from + going;
      treads.push({
        index,
        kind: 'straight',
        height: (index + 1) * riserHeight,
        polygon: [
          place(cursor, from, -width / 2),
          place(cursor, to, -width / 2),
          place(cursor, to, width / 2),
          place(cursor, from, width / 2),
        ],
        depthAtWalkline: going,
        minDepth: going,
        nosing: place(cursor, to, 0),
      });
      index += 1;
    }
    cursor = { origin: place(cursor, count * going, 0), rotation: cursor.rotation };
  };

  /**
   * Emits a landing and turns the cursor.
   *
   * A landing IS a tread — you step up onto it — so it consumes a riser. Its
   * depth in the direction of travel is the stair width, which is both the
   * usual detail and the easiest way to satisfy the 36 in the code asks for on
   * any stair wide enough to be legal in the first place.
   */
  const makeLanding = (turn: StairTurn, quarters: number) => {
    if (index >= treadCount) return;
    const depth = width;
    const side = lateralSign(turn);
    // A half-turn landing has to span both flights; a quarter-turn does not.
    const outer = quarters === 2 ? width * 1.5 : width / 2;

    const landing: Tread = {
      index,
      kind: 'landing',
      height: (index + 1) * riserHeight,
      polygon: [
        place(cursor, 0, side > 0 ? -width / 2 : -outer),
        place(cursor, depth, side > 0 ? -width / 2 : -outer),
        place(cursor, depth, side > 0 ? outer : width / 2),
        place(cursor, 0, side > 0 ? outer : width / 2),
      ],
      depthAtWalkline: depth,
      minDepth: depth,
      nosing: place(cursor, depth / 2, 0),
    };
    treads.push(landing);
    landings.push(landing);
    index += 1;

    if (quarters === 1) {
      // Step out to the middle of the landing and face the new direction.
      const origin = place(cursor, depth / 2, (side * width) / 2);
      cursor = { origin, rotation: turned(cursor.rotation, turn, 1) };
      // The new flight starts at the landing's outer edge, half a width along.
      cursor = { origin: place(cursor, -width / 2, 0), rotation: cursor.rotation };
    } else {
      // A half-turn: come back down the far side of the landing, one width over.
      const origin = place(cursor, depth, side * width);
      cursor = { origin, rotation: turned(cursor.rotation, turn, 2) };
    }
  };

  /**
   * Emits winder treads: tapered steps that turn the stair without a landing.
   *
   * Each is a sector between the newel post and the outer string, sharing the
   * turn between them. The depth that counts is the arc length at the walkline,
   * 12 in out from the post — see the comment on `innerRadius` in the schema for
   * why the post is what makes the geometry work at all.
   */
  const makeWinders = (turn: StairTurn, count: number, innerRadius: number) => {
    const side = lateralSign(turn);
    const step = Math.PI / 2 / Math.max(1, count);
    const walklineRadius = innerRadius + inches(12);

    // The pivot sits on the inside of the turn, one half-width across.
    const pivot = place(cursor, 0, (side * width) / 2);
    // The pivot sits on the inside edge, so the outer string is a full width out.
    const outerRadius = width;

    for (let i = 0; i < count && index < treadCount; i++) {
      const a0 = i * step;
      const a1 = a0 + step;

      /*
       * Points on the sector, addressed by angle from the incoming direction
       * and radius from the newel. One helper, one place for a sign to be
       * wrong, and a test that walks a turn and checks it ends up square.
       */
      const point = (angle: number, radius: number): Point2 => {
        const dir = rightOf(cursor.rotation - side * angle);
        return {
          x: pivot.x - side * dir.x * radius,
          z: pivot.z - side * dir.z * radius,
        };
      };

      treads.push({
        index,
        kind: 'winder',
        height: (index + 1) * riserHeight,
        polygon: [
          point(a0, innerRadius),
          point(a0, outerRadius),
          point(a1, outerRadius),
          point(a1, innerRadius),
        ],
        depthAtWalkline: walklineRadius * step,
        // At the newel the tread pinches to the post's own arc.
        minDepth: innerRadius * step,
        nosing: point(a1, walklineRadius),
      });
      index += 1;
    }

    // Leave the cursor at the far side of the turn, facing the new direction.
    const exitRotation = turned(cursor.rotation, turn, 1);
    const exit = {
      origin: {
        x: pivot.x - side * rightOf(exitRotation).x * (width / 2),
        z: pivot.z - side * rightOf(exitRotation).z * (width / 2),
      },
      rotation: exitRotation,
    };
    cursor = exit;
  };

  switch (form.kind) {
    case 'straight':
      runStraight(treadCount);
      break;

    case 'l-shaped': {
      const before = Math.max(1, Math.min(form.risersBeforeLanding, treadCount));
      runStraight(before - 1);
      makeLanding(form.turn, 1);
      runStraight(treadCount - index);
      break;
    }

    case 'u-shaped': {
      const before = Math.max(1, Math.min(form.risersBeforeLanding, treadCount));
      runStraight(before - 1);
      makeLanding(form.turn, 2);
      runStraight(treadCount - index);
      break;
    }

    case 'winder': {
      const before = Math.max(1, Math.min(form.risersBeforeWinder, treadCount));
      runStraight(before - 1);
      makeWinders(form.turn, form.winderTreads, form.innerRadius);
      runStraight(treadCount - index);
      break;
    }

    case 'spiral':
      // Handled by buildSpiral; unreachable here.
      break;
  }
}

/**
 * A helix around a central post.
 *
 * The angle per tread is derived rather than chosen: the code measures a
 * spiral's tread depth as an arc 12 in out from the narrow edge, so setting
 * that depth fixes the angle. Letting the user set both would let them specify
 * a stair that is two different shapes at once.
 */
function buildSpiral(
  stair: Stair,
  form: Extract<Stair['form'], { kind: 'spiral' }>,
  treadCount: number,
  riserHeight: number,
  treads: Tread[],
): void {
  const inner = Math.max(0.02, form.innerRadius);
  const outer = inner + stair.width;
  const walklineRadius = inner + inches(12);
  const step = walklineRadius > 0 ? stair.treadDepth / walklineRadius : 0.3;
  const sign = form.clockwise ? -1 : 1;

  // The post stands one radius in from the arrival point, on the turning side.
  const centre = {
    x: stair.at.x + rightOf(stair.rotation).x * sign * (inner + stair.width / 2),
    z: stair.at.z + rightOf(stair.rotation).z * sign * (inner + stair.width / 2),
  };

  const at = (angle: number, radius: number): Point2 => ({
    x: centre.x + Math.cos(angle) * radius,
    z: centre.z + Math.sin(angle) * radius,
  });

  // Angle from the post to the arrival point, so tread 0 starts where you do.
  const base = Math.atan2(stair.at.z - centre.z, stair.at.x - centre.x);

  for (let i = 0; i < treadCount; i++) {
    const a0 = base + sign * i * step;
    const a1 = a0 + sign * step;
    treads.push({
      index: i,
      kind: 'spiral',
      height: (i + 1) * riserHeight,
      polygon: [at(a0, inner), at(a0, outer), at(a1, outer), at(a1, inner)],
      depthAtWalkline: walklineRadius * step,
      minDepth: inner * step,
      nosing: at(a1, walklineRadius),
    });
  }
}

/* -------------------------------- Outlines -------------------------------- */

/**
 * The plan outline of the whole stair.
 *
 * A convex hull of the tread corners. Exact for a straight flight and for a
 * spiral's swept annulus at the resolution that matters; for an L or a U it
 * bridges the inside of the turn, which makes the footprint slightly generous.
 * That is the safe direction to be wrong in: the footprint is used to keep
 * furniture off the stair, and reserving a little extra floor beside a
 * staircase is right anyway.
 */
function outlineOf(stair: Stair, treads: Tread[]): Point2[] {
  const points: Point2[] = [stair.at];
  for (const tread of treads) points.push(...tread.polygon);
  return convexHull(points);
}

/**
 * The opening the stair needs in the floor above.
 *
 * Walk up the treads until one of them would put a head into the underside of
 * the storey above, and open the floor from there on. Below that point the
 * ceiling is untouched, which is both correct and what makes the space under a
 * staircase usable.
 */
function wellOpeningFor(
  doc: DesignDocument,
  stair: Stair,
  treads: Tread[],
  footprint: Point2[],
): Point2[] {
  const above = levelAbove(doc, stair.fromLevelId);
  if (!above || treads.length === 0) return [];

  const floorBelow = elevationOf(doc, stair.fromLevelId);
  const ceilingUnderside = elevationOf(doc, above.id) - above.slabThickness - floorBelow;
  const clearance = inches(80); // IRC R311.7.2 headroom.

  const needsOpening = treads.filter((tread) => ceilingUnderside - tread.height < clearance);
  if (needsOpening.length === 0) return [];

  // Everything from the first pinched tread upward, plus the arrival landing.
  const points: Point2[] = [];
  for (const tread of needsOpening) points.push(...tread.polygon);

  // The top of the stair arrives ON the floor above, so the opening has to
  // reach one going past the last tread or you step out onto thin air.
  const last = treads[treads.length - 1]!;
  const f = forwardOf(stair.rotation);
  for (const corner of last.polygon) {
    points.push({ x: corner.x + f.x * stair.treadDepth, z: corner.z + f.z * stair.treadDepth });
  }

  return needsOpening.length >= treads.length ? convexHull([...points, ...footprint]) : convexHull(points);
}

/** Andrew's monotone chain. Returns an anticlockwise hull. */
export function convexHull(points: readonly Point2[]): Point2[] {
  if (points.length < 3) return [...points];

  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.z - b.z : a.x - b.x));
  const cross = (o: Point2, a: Point2, b: Point2) =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  const build = (input: Point2[]): Point2[] => {
    const stack: Point2[] = [];
    for (const point of input) {
      while (
        stack.length >= 2 &&
        cross(stack[stack.length - 2]!, stack[stack.length - 1]!, point) <= 0
      ) {
        stack.pop();
      }
      stack.push(point);
    }
    stack.pop();
    return stack;
  };

  const lower = build(sorted);
  const upper = build([...sorted].reverse());
  return [...lower, ...upper];
}

/* -------------------------------- Defaults -------------------------------- */

/**
 * A sensible stair for a given storey height.
 *
 * Aims at a 7 in riser, which is the comfortable middle of the code's range
 * rather than its limit, then rounds to a whole number of steps and lets the
 * riser height fall where it lands. 11 in treads because anything at the 10 in
 * minimum is legal and unpleasant.
 */
export function defaultStairFor(rise: number): {
  riserCount: number;
  treadDepth: number;
  width: number;
  nosing: number;
} {
  const target = inches(7);
  const riserCount = Math.max(2, Math.round(rise / target));
  return {
    riserCount,
    treadDepth: inches(11),
    width: inches(36),
    nosing: inches(1),
  };
}

/* -------------------------------- Colliders ------------------------------- */

/**
 * A staircase, as something furniture cannot be put inside.
 *
 * One box per tread rather than one for the whole stair: exact for a straight
 * flight, and for a turned one it follows the actual shape instead of blocking
 * the open floor on the inside of the turn.
 *
 * A known limitation, stated rather than hidden: this blocks the space UNDER
 * the stairs as well as on them. Understairs storage is a real thing people
 * want, and supporting it needs collision that knows about height — the app's
 * colliders are flat footprints, deliberately, because that is what makes the
 * solver fast enough to run on every frame of a drag. Worth revisiting when
 * there is a reason to make collision three-dimensional; not worth faking now.
 */
export function stairColliders(doc: DesignDocument, levelId: string): Collider[] {
  const colliders: Collider[] = [];

  for (const stair of doc.stairs) {
    if (stair.fromLevelId !== levelId) continue;
    const geometry = stairGeometry(doc, stair);
    for (const tread of geometry.treads) {
      const box = obbOfQuad(tread.polygon);
      if (box) colliders.push({ kind: 'stair', id: `${stair.id}:${tread.index}`, ...box });
    }
  }

  return colliders;
}

/**
 * The tightest box around a quadrilateral, aligned to its first edge.
 *
 * Exact for the rectangles a straight flight is made of. For the tapered
 * treads of a winder it is slightly generous, which is the right way round —
 * reserving a little extra floor beside a staircase is good practice anyway.
 */
function obbOfQuad(polygon: readonly Point2[]): Obb | null {
  if (polygon.length < 3) return null;

  const a = polygon[0]!;
  const b = polygon[1]!;
  const edge = { x: b.x - a.x, z: b.z - a.z };
  const span = Math.hypot(edge.x, edge.z);
  if (span < 1e-9) return null;

  // Local X along the first edge, local Z perpendicular to it.
  const rotation = Math.atan2(edge.z, edge.x);
  const along = { x: edge.x / span, z: edge.z / span };
  const across = { x: -along.z, z: along.x };

  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;

  for (const point of polygon) {
    const u = point.x * along.x + point.z * along.z;
    const v = point.x * across.x + point.z * across.z;
    minAlong = Math.min(minAlong, u);
    maxAlong = Math.max(maxAlong, u);
    minAcross = Math.min(minAcross, v);
    maxAcross = Math.max(maxAcross, v);
  }

  const cu = (minAlong + maxAlong) / 2;
  const cv = (minAcross + maxAcross) / 2;

  return {
    center: { x: along.x * cu + across.x * cv, z: along.z * cu + across.z * cv },
    halfWidth: (maxAlong - minAlong) / 2,
    halfDepth: (maxAcross - minAcross) / 2,
    rotation,
  };
}
