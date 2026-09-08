/**
 * Laying out a bathroom.
 *
 * -----------------------------------------------------------------------------
 * A DIFFERENT PROBLEM FROM A KITCHEN.
 *
 * A kitchen is filled: you take the walls and put cabinetry on them until they
 * run out. A bathroom is PACKED: three or four large objects have to go into a
 * room that is usually too small, each with a clear floor space in front of it
 * that the code specifies to the inch, and the whole thing fails if any one of
 * them does not fit.
 *
 * So this works the other way round. It places fixtures in order of how hard
 * they are to fit — bath first because it is 1.7 m long and has to go along a
 * wall, then the WC because its clearance is the one that fails, then the basin
 * in whatever is left — and it checks each against the space it needs BEFORE
 * committing it, rather than placing everything and complaining afterwards.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT WILL NOT DO.
 *
 * It will not place a fixture it cannot give the clear floor space to. A
 * bathroom drawn with a WC 400 mm from the wall opposite is a bathroom that
 * cannot be built, and drawing one anyway — with a warning underneath — teaches
 * people to ignore warnings. It says what it could not fit, and why, in the
 * same breath as what it did.
 */

import { blankSpans, roomWalls, type RoomWall } from '@/advisor/geometry';
import { findRegions, pointInPolygon, type Region } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { addFixture, clearFittingsIn } from '@/state/fittingOps';
import { getFixture, type FixtureEntry } from '@/fittings/fixtures';
import { roomPurpose } from './rooms';
import type { DesignDocument, Level, Point2 } from '@/state/types';
import type { LayoutResult } from './kitchen';

/** Clear of the corner, so nothing is jammed into one. */
const CORNER_MARGIN = 0.05;

/**
 * What goes into a bathroom, hardest to fit first.
 *
 * The order is the whole algorithm. A bath has one position — along a wall long
 * enough for it — so it is placed first while every wall is still free. A basin
 * will go almost anywhere, so it goes last and takes what is left.
 */
const WANTED: ReadonlyArray<{ fixtureId: string; alternatives: readonly string[] }> = [
  { fixtureId: 'bath-1700', alternatives: ['bath-1500', 'shower-1200', 'shower-900'] },
  { fixtureId: 'wc-close-coupled', alternatives: [] },
  { fixtureId: 'basin-vanity-600', alternatives: ['basin-pedestal'] },
];

/** A stretch of wall a fixture can stand against. */
interface Spot {
  wall: RoomWall;
  from: number;
  to: number;
  length: number;
}

function spotsIn(level: Level, region: Region): Spot[] {
  const spots: Spot[] = [];
  for (const wall of roomWalls(level.plan, region)) {
    for (const span of blankSpans(wall, CORNER_MARGIN, 0.35)) {
      // A door needs the sweep of its leaf clear, same as in a kitchen.
      let from = span.from;
      let to = span.to;
      for (const opening of wall.openingSpans) {
        const width = opening.to - opening.from;
        if (opening.to <= from + 1e-6) from = Math.max(from, opening.to + width * 0.5);
        if (opening.from >= to - 1e-6) to = Math.min(to, opening.from - width * 0.5);
      }
      if (to - from < 0.35) continue;
      spots.push({ wall, from, to, length: to - from });
    }
  }
  return spots.sort((a, b) => b.length - a.length);
}

/** Where a fixture would stand, centred at `along` on a wall. */
function positionOn(spot: Spot, along: number, entry: FixtureEntry): { at: Point2; rotation: number } {
  const { wall } = spot;
  const t = along / wall.length;
  const face = {
    x: wall.faceStart.x + (wall.faceEnd.x - wall.faceStart.x) * t,
    z: wall.faceStart.z + (wall.faceEnd.z - wall.faceStart.z) * t,
  };
  return {
    at: {
      x: face.x + wall.inward.x * (entry.depth / 2),
      z: face.z + wall.inward.z * (entry.depth / 2),
    },
    rotation: wall.seatRotation,
  };
}

/**
 * How much clear space this fixture needs each side of its centre line.
 *
 * Read off the fixture rather than written here, so the layout and the checker
 * are working from one copy of IRC R307.1 — 15 in for a WC or a bidet, nothing
 * for anything else. Half the fixture's own width is inside it, so the figure
 * that actually constrains a position is whichever is larger.
 */
function sideClearance(entry: FixtureEntry): number {
  const side = entry.clearances.find(
    (clearance) => clearance.side === 'left' || clearance.side === 'right',
  );
  return Math.max(entry.width / 2, side?.metres ?? 0);
}

/**
 * Whether a fixture placed here has the clear floor it needs, inside the room
 * and not overlapping anything already placed.
 *
 * The front clearance is tested as a strip of points rather than as a
 * rectangle-in-polygon test, because the room may be L-shaped and a rectangle
 * test would either pass a fixture whose clearance runs out of the room or
 * fail one whose corner clips a chamfer.
 */
function fits(
  entry: FixtureEntry,
  place: { at: Point2; rotation: number },
  spot: Spot,
  region: Region,
  taken: ReadonlyArray<{ at: Point2; half: number }>,
): boolean {
  const inward = spot.wall.inward;
  const front = entry.clearances.find((clearance) => clearance.side === 'front');
  const reach = entry.depth / 2 + (front?.metres ?? 0.2);

  // Along the fixture's own width, and out to the far edge of its clearance.
  const across = { x: -inward.z, z: inward.x };
  for (const side of [-0.45, 0, 0.45]) {
    for (const step of [0.35, 0.7, 1]) {
      const probe = {
        x: place.at.x + across.x * entry.width * side + inward.x * (reach * step - entry.depth / 2),
        z: place.at.z + across.z * entry.width * side + inward.z * (reach * step - entry.depth / 2),
      };
      if (!pointInPolygon(probe, region.polygon)) return false;
    }
  }

  // And nothing already placed is standing in it.
  const half = Math.max(entry.width, entry.depth) / 2;
  for (const other of taken) {
    const gap = Math.hypot(other.at.x - place.at.x, other.at.z - place.at.z);
    if (gap < half + other.half - 0.05) return false;
  }

  /*
   * The 15 in each side of a WC's centre line, which is the rule that catches
   * a pan jammed into a corner. Checked here rather than left to the checker,
   * because a layout that knowingly produces a violation and then reports it
   * teaches people to ignore the report.
   */
  const side = sideClearance(entry);
  if (side > entry.width / 2) {
    for (const sign of [1, -1]) {
      const probe = {
        x: place.at.x + across.x * sign * side,
        z: place.at.z + across.z * sign * side,
      };
      if (!pointInPolygon(probe, region.polygon)) return false;

      for (const other of taken) {
        if (Math.hypot(other.at.x - probe.x, other.at.z - probe.z) < other.half) return false;
      }
    }
  }

  return true;
}

/* -------------------------------- The layout ------------------------------ */

export function layoutBathroom(doc: DesignDocument, level: Level, region: Region): LayoutResult {
  clearFittingsIn(doc, level.id, region.polygon);

  const spots = spotsIn(level, region);
  const assumptions: string[] = [];
  const taken: Array<{ at: Point2; half: number }> = [];
  let fixtures = 0;

  if (spots.length === 0) {
    return {
      runs: 0,
      fixtures: 0,
      assumptions: [
        'Every wall in this room is taken up by a door, so there is nowhere to stand anything. Nothing was laid out.',
      ],
    };
  }

  for (const want of WANTED) {
    const candidates = [want.fixtureId, ...want.alternatives];
    let placed = false;

    for (const fixtureId of candidates) {
      const entry = getFixture(fixtureId);
      if (!entry) continue;

      for (const spot of spots) {
        if (spot.length < entry.width) continue;

        /*
         * Three positions per wall, tried in order: hard against each end, then
         * the middle. Ends first because a bathroom is packed and a fixture in
         * the middle of a wall wastes the two stretches either side of it.
         */
        const margin = sideClearance(entry);
        const positions = [
          spot.from + margin,
          spot.to - margin,
          (spot.from + spot.to) / 2,
        ];

        for (const along of positions) {
          const place = positionOn(spot, along, entry);
          if (!fits(entry, place, spot, region, taken)) continue;

          const id = addFixture(doc, level.id, entry.id, place.at);
          if (!id) continue;

          // `addFixture` seats it against the nearest wall, which may not be
          // the one it was chosen for in a narrow room. Put it back.
          const fixture = doc.fixtures.find((candidate) => candidate.id === id)!;
          fixture.at = place.at;
          fixture.rotation = place.rotation;

          taken.push({ at: place.at, half: Math.max(entry.width, entry.depth) / 2 });
          fixtures += 1;
          placed = true;
          break;
        }
        if (placed) break;
      }
      if (placed) break;
    }

    if (!placed) {
      const entry = getFixture(want.fixtureId);
      assumptions.push(
        `There was nowhere to put a ${entry?.name.toLowerCase() ?? want.fixtureId} with the clear floor space IRC R307.1 asks for, so none was placed. Make the room bigger, move a door, or place one by hand and see what the checks say.`,
      );
    }
  }

  if (fixtures > 0) {
    assumptions.push(
      'Fixtures are the app’s defaults at typical sizes. Check them against what you actually buy — a bathroom is planned to the centimetre, and a bath 50 mm longer than this one may not go in.',
    );
  }

  return { runs: 0, fixtures, assumptions };
}

/* ------------------------------ Whole storey ------------------------------ */

/** Every room whose name says it is a bathroom. */
export function bathroomsIn(doc: DesignDocument): Array<{ level: Level; region: Region }> {
  const found: Array<{ level: Level; region: Region }> = [];
  for (const level of doc.levels) {
    for (const region of findRegions(level.plan)) {
      const spec = resolveRoomSpec(level.plan, region.key);
      if (roomPurpose(spec.name) === 'bathroom') found.push({ level, region });
    }
  }
  return found;
}

export function layoutAllBathrooms(doc: DesignDocument): LayoutResult {
  const rooms = bathroomsIn(doc);
  if (rooms.length === 0) {
    return {
      runs: 0,
      fixtures: 0,
      assumptions: ['No room is named as a bathroom, so there was nothing to lay out.'],
    };
  }

  let fixtures = 0;
  const assumptions: string[] = [];

  for (const { level, region } of rooms) {
    const result = layoutBathroom(doc, level, region);
    fixtures += result.fixtures;
    for (const note of result.assumptions) {
      if (!assumptions.includes(note)) assumptions.push(note);
    }
  }

  return { runs: 0, fixtures, assumptions };
}
