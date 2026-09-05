/**
 * Laying out a kitchen.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS DECIDES, AND WHAT IT REFUSES TO.
 *
 * It decides which walls take cabinetry, where the sink, the hob and the fridge
 * go, and what fills the rest. It refuses to decide anything that depends on
 * how somebody cooks — whether they want a bin drawer, whether the dishwasher
 * goes left or right of the sink, whether the tall units are larders or ovens.
 * Those are preferences, and the layout is a starting point rather than a
 * design.
 *
 * -----------------------------------------------------------------------------
 * THE THREE RULES IT WORKS BY.
 *
 *   1. THE SINK GOES UNDER A WINDOW. Not because a code says so — none does —
 *      but because it is where every kitchen in the world puts it, and because
 *      it is the one position that is genuinely determined by the room rather
 *      than by taste. Where there is no window on a run, it goes on the longest
 *      one, near the middle.
 *
 *   2. THE HOB GOES ON A DIFFERENT LEG FROM THE SINK, if there is one. That is
 *      what opens the working triangle: sink and hob on the same wall with the
 *      fridge opposite gives a triangle of two long legs and one that is zero,
 *      which is a galley you cannot turn round in.
 *
 *   3. NOTHING GOES ACROSS A DOORWAY. A run stops at a door and starts again
 *      after it, and a door's swing is subtracted before anything is placed —
 *      because a cupboard behind an open door is a cupboard nobody opens.
 *
 * -----------------------------------------------------------------------------
 * THE WORKING TRIANGLE IS MEASURED, NOT ASSUMED.
 *
 * The layout proposes; `fittingCheck.ts` then measures the result against the
 * same figures an assessor would use, and reports what it finds. The two are
 * written separately for the same reason the electrical layout and the NEC
 * checks are: if they disagree, one of them is wrong, and a test says which.
 */

import { roomWalls, type RoomWall, type Span } from '@/advisor/geometry';
import { findRegions, type Region } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { addFixture, addRun, clearFittingsIn, hostFixture } from '@/state/fittingOps';
import { CARCASS } from '@/fittings/modules';
import { defaultFixture } from '@/fittings/fixtures';
import { roomPurpose } from './rooms';
import type { Anchor } from '@/building/cabinetRun';
import type { CabinetKind, DesignDocument, Level, Point2 } from '@/state/types';

/** How much wall a run needs before it is worth having. */
const MIN_RUN = 0.6;

/** Clear of the corner, so a door has somewhere to open into. */
const CORNER_MARGIN = 0.05;

export interface LayoutResult {
  runs: number;
  fixtures: number;
  /** What it had to assume, in the user's words. */
  assumptions: string[];
}

/**
 * A stretch of wall a run can sit on.
 *
 * Carries the wall it came from so the window positions survive: knowing that
 * a stretch is 3.2 m long is not enough to put the sink under the window.
 */
interface Stretch {
  wall: RoomWall;
  /** Along the wall's interior face. */
  from: number;
  to: number;
  length: number;
  /** Centres of the windows over this stretch, measured along it. */
  windows: number[];
}

/* ------------------------- Which openings are which ----------------------- */

/**
 * The doors and the windows on a room wall, told apart.
 *
 * `RoomWall.openingSpans` gives every opening's position along the wall's
 * interior face but not its KIND, and the difference is the whole layout: a
 * base run passes happily under a window — a sink under one is the point — and
 * must not pass a door at all.
 *
 * The awkward part is that a room wall may be traversed in the opposite
 * direction from the plan wall it came from, in which case every offset is
 * mirrored. Rather than reasoning about which, both orderings are built and the
 * one that matches the spans already computed is the one used.
 */
function classifyOpenings(level: Level, wall: RoomWall): { doors: Span[]; windows: Span[] } {
  const planWall = level.plan.walls.find((entry) => entry.id === wall.wallId);
  if (!planWall || planWall.openings.length === 0) return { doors: [], windows: [] };

  const forward = planWall.openings.map((opening) => ({
    kind: opening.kind,
    from: opening.offset - opening.width / 2,
    to: opening.offset + opening.width / 2,
  }));
  const reversed = planWall.openings.map((opening) => ({
    kind: opening.kind,
    from: wall.length - opening.offset - opening.width / 2,
    to: wall.length - opening.offset + opening.width / 2,
  }));

  /** How far a candidate ordering is from the spans the wall reported. */
  const error = (candidates: typeof forward) =>
    wall.openingSpans.reduce((total, span) => {
      const nearest = Math.min(...candidates.map((entry) => Math.abs(entry.from - span.from)));
      return total + nearest;
    }, 0);

  const chosen = error(forward) <= error(reversed) ? forward : reversed;

  return {
    doors: chosen.filter((entry) => entry.kind === 'door').map(({ from, to }) => ({ from, to })),
    windows: chosen.filter((entry) => entry.kind === 'window').map(({ from, to }) => ({ from, to })),
  };
}

/**
 * The stretches of a wall left over after the doors.
 *
 * The complement of the door spans, each widened by half a leaf so a cupboard
 * is not trapped behind an open door. Windows are deliberately ignored: base
 * units run under them.
 */
function stretchesBetweenDoors(wall: RoomWall, doors: readonly Span[]): Span[] {
  const blocked = doors
    .map((door) => {
      const leaf = (door.to - door.from) * 0.5;
      return { from: door.from - leaf, to: door.to + leaf };
    })
    .sort((a, b) => a.from - b.from);

  const spans: Span[] = [];
  let cursor = CORNER_MARGIN;

  for (const door of blocked) {
    if (door.from - cursor >= MIN_RUN) spans.push({ from: cursor, to: door.from });
    cursor = Math.max(cursor, door.to);
  }
  const end = wall.length - CORNER_MARGIN;
  if (end - cursor >= MIN_RUN) spans.push({ from: cursor, to: end });

  return spans;
}

/* -------------------------------- Choosing -------------------------------- */

/**
 * The stretches of wall worth putting cabinetry on.
 *
 * A doorway takes out the width of the door plus the space its leaf sweeps —
 * `blankSpans` already excludes the opening itself, and the extra margin here
 * is what keeps a cupboard from being trapped behind an open door.
 */
function stretchesFor(level: Level, region: Region, forWallUnits: boolean): Stretch[] {
  const stretches: Stretch[] = [];

  for (const wall of roomWalls(level.plan, region)) {
    const { doors, windows } = classifyOpenings(level, wall);

    for (const span of stretchesBetweenDoors(wall, doors)) {
      const centres = windows
        .map((window) => (window.from + window.to) / 2)
        .filter((centre) => centre > span.from && centre < span.to);

      /*
       * WALL units may not cross a window — there is nothing to fix them to —
       * so a stretch with one is split either side of it.
       *
       * BASE units may, and must: a sink under a window is where every kitchen
       * in the world puts it, and treating a window as an obstruction is
       * exactly the mistake that sends the sink to the opposite wall.
       */
      if (forWallUnits && windows.length > 0) {
        let cursor = span.from;
        for (const window of [...windows].sort((a, b) => a.from - b.from)) {
          if (window.from <= cursor || window.from >= span.to) continue;
          if (window.from - cursor >= MIN_RUN) {
            stretches.push({
              wall,
              from: cursor,
              to: window.from,
              length: window.from - cursor,
              windows: [],
            });
          }
          cursor = Math.max(cursor, window.to);
        }
        if (span.to - cursor >= MIN_RUN) {
          stretches.push({ wall, from: cursor, to: span.to, length: span.to - cursor, windows: [] });
        }
        continue;
      }

      stretches.push({
        wall,
        from: span.from,
        to: span.to,
        length: span.to - span.from,
        windows: centres,
      });
    }
  }

  return stretches.sort((a, b) => b.length - a.length);
}

/**
 * Whether a stretch's path runs backwards along its wall.
 *
 * The path has to be ordered so its anticlockwise normal points into the room,
 * and for half the walls of any room that means running it the opposite way
 * from the wall's own direction. Everything measured ALONG the wall — where the
 * window is, where the sink should go — then has to be converted, or the sink
 * lands at the far end of the run from the window it was meant to be under.
 */
function isReversed(stretch: Stretch): boolean {
  const { wall } = stretch;
  const direction = { x: wall.faceEnd.x - wall.faceStart.x, z: wall.faceEnd.z - wall.faceStart.z };
  const normal = { x: -direction.z, z: direction.x };
  return normal.x * wall.inward.x + normal.z * wall.inward.z <= 0;
}

/** A distance measured along the wall, as a distance along the run's path. */
function alongPath(stretch: Stretch, onWall: number): number {
  return isReversed(stretch) ? stretch.to - onWall : onWall - stretch.from;
}

/** The world path of a stretch, along the wall's interior face. */
function pathOf(stretch: Stretch): Point2[] {
  const { wall } = stretch;
  const along = (distance: number): Point2 => ({
    x: wall.faceStart.x + (wall.faceEnd.x - wall.faceStart.x) * (distance / wall.length),
    z: wall.faceStart.z + (wall.faceEnd.z - wall.faceStart.z) * (distance / wall.length),
  });

  /*
   * The path has to run so that its anticlockwise normal points INTO the room,
   * because that is the convention every piece of run geometry depends on. The
   * wall knows its own inward direction, so the two ends are simply ordered to
   * agree with it rather than tested afterwards.
   */
  const start = along(stretch.from);
  const end = along(stretch.to);
  return isReversed(stretch) ? [end, start] : [start, end];
}

/* -------------------------------- The layout ------------------------------ */

/**
 * Lays out one kitchen.
 *
 * Returns what it did and what it had to assume. Anything already in the room
 * is cleared first — laying out twice should give the same kitchen, not two
 * kitchens on top of each other.
 */
export function layoutKitchen(doc: DesignDocument, level: Level, region: Region): LayoutResult {
  const assumptions: string[] = [];
  clearFittingsIn(doc, level.id, region.polygon);

  const bases = stretchesFor(level, region, false);
  if (bases.length === 0) {
    return {
      runs: 0,
      fixtures: 0,
      assumptions: [
        'No wall in this room is long enough to take cabinetry once the doors are allowed for, so nothing was laid out.',
      ],
    };
  }

  /* ---- Which stretch gets the sink ---- */

  // A window, if there is one; otherwise the middle of the longest wall.
  const withWindow = bases.find((stretch) => stretch.windows.length > 0);
  const sinkOn = withWindow ?? bases[0]!;
  // Kept in the wall's own coordinates; converted to the path's when anchored.
  const sinkOnWall = withWindow ? withWindow.windows[0]! : (sinkOn.from + sinkOn.to) / 2;

  if (!withWindow) {
    assumptions.push(
      'No window looks onto a wall that could take cabinetry, so the sink is in the middle of the longest run. A sink is normally under a window — move it if there is somewhere better.',
    );
  }

  /* ---- Which gets the hob ---- */

  const hobOn = bases.length > 1 ? bases[1]! : sinkOn;
  const sinkAt = alongPath(sinkOn, sinkOnWall);
  const hobAt =
    hobOn === sinkOn
      ? // Same wall: as far from the sink as the run allows, so the two are not
        // elbow to elbow. 1.4 m is the smallest gap that leaves working space.
        sinkAt > sinkOn.length / 2
        ? Math.max(0.6, sinkAt - 1.4)
        : Math.min(sinkOn.length - 0.6, sinkAt + 1.4)
      : hobOn.length / 2;

  if (hobOn === sinkOn) {
    assumptions.push(
      'There is only one usable wall, so the sink and the hob share it. A galley with both on one side works, but the run between them is the whole kitchen — check it is long enough.',
    );
  }

  /* ---- Build the runs ---- */

  let runCount = 0;
  let fixtureCount = 0;
  const hostFor = new Map<string, string>();

  for (const stretch of bases.slice(0, 3)) {
    const anchored: Anchor[] = [];
    if (stretch === sinkOn) anchored.push({ moduleId: 'base-800-sink', at: sinkAt });
    if (stretch === hobOn) anchored.push({ moduleId: 'base-600-hob', at: hobAt });

    // The dishwasher goes beside the sink, which is where its plumbing already
    // is. On the sink's own run, immediately after it.
    const required: string[] = [];
    if (stretch === sinkOn) required.push('base-600-appliance');

    const runId = addRun(doc, level.id, pathOf(stretch), 'base', { anchored, required });
    if (!runId) continue;
    runCount += 1;

    const run = doc.runs.find((entry) => entry.id === runId)!;
    for (const unit of run.units) {
      if (unit.moduleId === 'base-800-sink' && !hostFor.has('sink')) hostFor.set('sink', unit.id);
      if (unit.moduleId === 'base-600-hob' && !hostFor.has('hob')) hostFor.set('hob', unit.id);
      if (unit.moduleId === 'base-600-appliance' && !hostFor.has('dishwasher')) {
        hostFor.set('dishwasher', unit.id);
      }
    }
  }

  /* ---- Wall units over them, where a window does not stop them ---- */

  for (const stretch of stretchesFor(level, region, true).slice(0, 3)) {
    // Not over the hob: that space belongs to the extractor.
    const hobOnWall = isReversed(hobOn) ? hobOn.to - hobAt : hobOn.from + hobAt;
    const overHob =
      stretch.wall.wallId === hobOn.wall.wallId &&
      hobOnWall > stretch.from - 0.4 &&
      hobOnWall < stretch.to + 0.4;

    const runId = addRun(doc, level.id, pathOf(stretch), 'wall', {
      anchored: overHob
        ? [{ moduleId: 'wall-600-extractor', at: alongPath(stretch, hobOnWall) }]
        : [],
    });
    if (runId) runCount += 1;
  }

  /* ---- The fixtures ---- */

  /*
   * Only placed when the run that takes it actually got built. A sink with no
   * sink base is a sink standing in the middle of the floor, and putting one
   * there because the layout said "there is a sink in a kitchen" is exactly
   * the kind of confident nonsense this app is trying not to produce.
   */
  const place = (fixtureKind: Parameters<typeof defaultFixture>[0], hostKey: string) => {
    const entry = defaultFixture(fixtureKind);
    const host = hostFor.get(hostKey);
    if (!entry || !host) return;

    const id = addFixture(doc, level.id, entry.id, region.interiorPoint);
    if (!id) return;
    fixtureCount += 1;
    hostFixture(doc, id, host);
  };

  place('sink', 'sink');
  place('hob', 'hob');
  place('dishwasher', 'dishwasher');

  // The extractor, over the hob, in its housing.
  const extractorUnit = doc.runs
    .filter((run) => run.levelId === level.id && run.kind === 'wall')
    .flatMap((run) => run.units)
    .find((unit) => unit.moduleId === 'wall-600-extractor');
  if (extractorUnit) {
    const entry = defaultFixture('extractor');
    if (entry) {
      const id = addFixture(doc, level.id, entry.id, region.interiorPoint);
      if (id) {
        fixtureCount += 1;
        hostFixture(doc, id, extractorUnit.id);
      }
    }
  }

  /* ---- The fridge, at the end of the longest run ---- */

  const fridge = defaultFixture('fridge-freezer');
  if (fridge) {
    const stretch = bases[0]!;
    const path = pathOf(stretch);
    const end = path[1]!;
    const direction = { x: end.x - path[0]!.x, z: end.z - path[0]!.z };
    const length = Math.hypot(direction.x, direction.z) || 1;
    const inward = { x: -direction.z / length, z: direction.x / length };

    // Just past the end of the run, standing on the same line.
    const at = {
      x: end.x - (direction.x / length) * (fridge.width / 2) + inward.x * (CARCASS.base.depth / 2),
      z: end.z - (direction.z / length) * (fridge.width / 2) + inward.z * (CARCASS.base.depth / 2),
    };
    if (addFixture(doc, level.id, fridge.id, at)) fixtureCount += 1;
  }

  assumptions.push(
    'Cabinet fronts, worktop and appliances are the app’s defaults. Module widths follow the IKEA METOD series; nothing here is a quotation and no product has been checked against a listing.',
  );

  return { runs: runCount, fixtures: fixtureCount, assumptions };
}

/* ------------------------------ Whole storey ------------------------------ */

/** Every room whose name says it is a kitchen, on any storey. */
export function kitchensIn(doc: DesignDocument): Array<{ level: Level; region: Region }> {
  const found: Array<{ level: Level; region: Region }> = [];
  for (const level of doc.levels) {
    for (const region of findRegions(level.plan)) {
      const spec = resolveRoomSpec(level.plan, region.key);
      if (roomPurpose(spec.name) === 'kitchen') found.push({ level, region });
    }
  }
  return found;
}

/** Lays out every kitchen in the building. */
export function layoutAllKitchens(doc: DesignDocument): LayoutResult {
  const rooms = kitchensIn(doc);
  if (rooms.length === 0) {
    return {
      runs: 0,
      fixtures: 0,
      assumptions: ['No room is named as a kitchen, so there was nothing to lay out.'],
    };
  }

  let runs = 0;
  let fixtures = 0;
  const assumptions: string[] = [];

  for (const { level, region } of rooms) {
    const result = layoutKitchen(doc, level, region);
    runs += result.runs;
    fixtures += result.fixtures;
    for (const note of result.assumptions) {
      if (!assumptions.includes(note)) assumptions.push(note);
    }
  }

  return { runs, fixtures, assumptions };
}

export type { Stretch, CabinetKind };
