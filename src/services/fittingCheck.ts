/**
 * Checking the kitchens and bathrooms.
 *
 * Same contract as the stair, roof and electrical checks: every finding names
 * the measurement, the limit and the section, so anybody can open the code book
 * and see in thirty seconds whether we read it right.
 *
 * -----------------------------------------------------------------------------
 * TWO KINDS OF FINDING, AND THE DIFFERENCE MATTERS.
 *
 * The bathroom clearances and the ventilation are CODE. A house that fails them
 * fails an inspection, and they are reported as violations.
 *
 * The working triangle and the worktop landings are ERGONOMICS. There is no
 * section anywhere requiring them, a kitchen that fails every one of them is
 * perfectly legal, and they are reported as advice with `section` left empty —
 * which is how the UI knows not to print a citation that does not exist.
 *
 * Blurring those two is the thing that makes people stop reading warnings. If
 * the app tells somebody their working triangle is a violation, they will
 * rightly conclude the app does not know what a violation is.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS NOT CHECKED.
 *
 * Anything structural (is there a joist under that bath), anything about
 * waterproofing or tanking, and anything about gas. Those depend on how the
 * building is actually built and on decisions nobody has made yet, and a
 * plausible-looking answer would be worse than none.
 */

import { IRC_BATHROOM, IRC_VENTILATION, KITCHEN_ERGONOMICS, asFeetInches } from '@/code/irc';
import { counterLines, runSegments } from '@/building/cabinetRun';
import { getFixture, isSanitary, type FixtureEntry } from '@/fittings/fixtures';
import { findRegions, pointInPolygon, type Region } from '@/scene/planGraph';
import { roomWalls } from '@/advisor/geometry';
import { resolveRoomSpec } from '@/state/planOps';
import { roomPurpose, type RoomPurpose } from './rooms';
import type { DesignDocument, Fixture, Level, Point2 } from '@/state/types';

export type FittingSeverity = 'violation' | 'caution' | 'advice' | 'pass';

export interface FittingFinding {
  id: string;
  severity: FittingSeverity;
  /** The section, or empty when the finding is ergonomics rather than code. */
  section: string;
  title: string;
  detail: string;
  remedy: string;
  /** The room it is about, for navigating to it. */
  roomName: string;
}

export interface FittingReport {
  findings: FittingFinding[];
  compliant: boolean;
}

/* ---------------------------------- Run ----------------------------------- */

export function checkFittings(doc: DesignDocument): FittingReport {
  const findings: FittingFinding[] = [];
  const add = (finding: FittingFinding) => findings.push(finding);

  if (doc.runs.length === 0 && doc.fixtures.length === 0) {
    return { findings, compliant: true };
  }

  for (const level of doc.levels) {
    for (const region of findRegions(level.plan)) {
      const spec = resolveRoomSpec(level.plan, region.key);
      const purpose = roomPurpose(spec.name);

      if (purpose === 'bathroom') checkBathroom(doc, level, region, spec.name, add);
      if (purpose === 'kitchen') checkKitchen(doc, level, region, spec.name, add);
      checkVentilation(doc, level, region, spec.name, purpose, add);
    }
  }

  return {
    findings,
    compliant: findings.every((finding) => finding.severity !== 'violation'),
  };
}

/* ------------------------------- Bathrooms -------------------------------- */

/**
 * IRC R307.1 — the clear floor space in front of every sanitary fixture.
 *
 * Measured from the front edge of the fixture outwards, along the direction it
 * faces, and tested against the ROOM as well as against everything else in it:
 * a WC with 21 in of clear floor that runs out of the room at 18 in has 18 in.
 */
function checkBathroom(
  doc: DesignDocument,
  level: Level,
  region: Region,
  roomName: string,
  add: (finding: FittingFinding) => void,
): void {
  const inRoom = doc.fixtures.filter(
    (fixture) => fixture.levelId === level.id && pointInPolygon(fixture.at, region.polygon),
  );
  const sanitary = inRoom.filter((fixture) => {
    const entry = getFixture(fixture.fixtureId);
    return entry ? isSanitary(entry.kind) : false;
  });

  if (sanitary.length === 0) return;

  /* ---- Clear floor in front ---- */

  let worst: { fixture: Fixture; entry: FixtureEntry; clear: number; needed: number } | null = null;

  for (const fixture of sanitary) {
    const entry = getFixture(fixture.fixtureId);
    if (!entry) continue;

    const front = entry.clearances.find((clearance) => clearance.side === 'front');
    if (!front) continue;

    const clear = clearInFront(fixture, entry, region, inRoom);
    if (!worst || clear - front.metres < worst.clear - worst.needed) {
      worst = { fixture, entry, clear, needed: front.metres };
    }
  }

  if (worst) {
    const short = worst.clear < worst.needed - 0.005;
    add({
      id: `fit-r307-front-${region.key}`,
      severity: short ? 'violation' : 'pass',
      section: IRC_BATHROOM.clearInFront.section,
      title: short
        ? `The ${worst.entry.name.toLowerCase()} has no room in front of it`
        : 'Every fixture has the clear floor it needs',
      detail: short
        ? `There is ${asFeetInches(worst.clear)} of clear floor in front of the ${worst.entry.name.toLowerCase()}; IRC ${IRC_BATHROOM.clearInFront.section} asks for ${IRC_BATHROOM.clearInFront.asWritten}. It is measured from the front edge of the fixture, not from the wall behind it.`
        : `The tightest is ${asFeetInches(worst.clear)} in front of the ${worst.entry.name.toLowerCase()}, against the ${IRC_BATHROOM.clearInFront.asWritten} IRC ${IRC_BATHROOM.clearInFront.section} asks for.`,
      remedy: short
        ? 'Move the fixture, turn it to face a longer direction, or make the room deeper.'
        : '',
      roomName,
    });
  }

  /* ---- 15 in from a WC centreline to anything beside it ---- */

  for (const fixture of sanitary) {
    const entry = getFixture(fixture.fixtureId);
    if (!entry || (entry.kind !== 'wc' && entry.kind !== 'bidet')) continue;

    const side = clearBeside(fixture, entry, region, inRoom);
    if (side >= IRC_BATHROOM.wcCentreToWall.metres - 0.005) continue;

    add({
      id: `fit-r307-side-${fixture.id}`,
      severity: 'violation',
      section: IRC_BATHROOM.wcCentreToWall.section,
      title: `No elbow room beside the ${entry.name.toLowerCase()}`,
      detail: `There is ${asFeetInches(side)} from its centre line to what is beside it; IRC ${IRC_BATHROOM.wcCentreToWall.section} asks for ${IRC_BATHROOM.wcCentreToWall.asWritten}. Two fixtures side by side therefore need 30 in between their centres.`,
      remedy: 'Move it along the wall, or move whatever is beside it.',
      roomName,
    });
  }

  /* ---- R307.2, the shower itself ---- */

  for (const fixture of sanitary) {
    const entry = getFixture(fixture.fixtureId);
    if (!entry || entry.kind !== 'shower') continue;

    const area = entry.width * entry.depth;
    const smallest = Math.min(entry.width, entry.depth);
    const tooSmall =
      area < IRC_BATHROOM.showerArea.squareMetres - 1e-6 ||
      smallest < IRC_BATHROOM.showerArea.minDimension - 1e-6;
    if (!tooSmall) continue;

    add({
      id: `fit-r307-shower-${fixture.id}`,
      severity: 'violation',
      section: IRC_BATHROOM.showerArea.section,
      title: 'The shower is smaller than the code allows',
      detail: `It is ${asFeetInches(entry.width)} by ${asFeetInches(entry.depth)}. IRC ${IRC_BATHROOM.showerArea.section} asks for ${IRC_BATHROOM.showerArea.asWritten}.`,
      remedy: 'Fit a larger tray.',
      roomName,
    });
  }
}

/**
 * How much clear floor there is in front of a fixture.
 *
 * Walked outwards in 25 mm steps from the fixture's front edge until the probe
 * leaves the room or hits something. Stepping rather than solving because the
 * room may be any shape and the obstruction may be any other fixture — and at
 * 25 mm the answer is finer than anything anybody builds to.
 */
function clearInFront(
  fixture: Fixture,
  entry: FixtureEntry,
  region: Region,
  others: readonly Fixture[],
): number {
  // Zero rotation faces +Z, which is the convention everything here uses.
  const facing = { x: Math.sin(fixture.rotation), z: Math.cos(fixture.rotation) };
  const front = {
    x: fixture.at.x + facing.x * (entry.depth / 2),
    z: fixture.at.z + facing.z * (entry.depth / 2),
  };

  const limit = 1.5;
  for (let distance = 0; distance <= limit; distance += 0.025) {
    const probe = { x: front.x + facing.x * distance, z: front.z + facing.z * distance };
    if (!pointInPolygon(probe, region.polygon)) return distance;

    for (const other of others) {
      if (other.id === fixture.id) continue;
      const otherEntry = getFixture(other.fixtureId);
      if (!otherEntry) continue;
      // A rough footprint test: a bath is a box and so is everything else here,
      // and the half-diagonal is close enough at 25 mm resolution.
      const reach = Math.min(otherEntry.width, otherEntry.depth) / 2;
      if (Math.hypot(other.at.x - probe.x, other.at.z - probe.z) < reach) return distance;
    }
  }
  return limit;
}

/** The nearer of the two sides, from a fixture's centre line. */
function clearBeside(
  fixture: Fixture,
  entry: FixtureEntry,
  region: Region,
  others: readonly Fixture[],
): number {
  const across = { x: Math.cos(fixture.rotation), z: -Math.sin(fixture.rotation) };
  let nearest = 1;

  for (const sign of [1, -1]) {
    for (let distance = 0.05; distance <= 1; distance += 0.025) {
      const probe = {
        x: fixture.at.x + across.x * sign * distance,
        z: fixture.at.z + across.z * sign * distance,
      };

      let blocked = !pointInPolygon(probe, region.polygon);
      if (!blocked) {
        for (const other of others) {
          if (other.id === fixture.id) continue;
          const otherEntry = getFixture(other.fixtureId);
          if (!otherEntry) continue;
          const reach = Math.min(otherEntry.width, otherEntry.depth) / 2;
          if (Math.hypot(other.at.x - probe.x, other.at.z - probe.z) < reach) blocked = true;
        }
      }

      if (blocked) {
        nearest = Math.min(nearest, distance);
        break;
      }
    }
  }

  // Half the fixture's own width is inside it, so it never counts as clear.
  return Math.max(nearest, entry.width / 2);
}

/* -------------------------------- Kitchens -------------------------------- */

/**
 * The working triangle and the worktop, reported as ergonomics.
 *
 * The triangle is measured centre to centre between the sink, the hob and the
 * cold store, which is how every source that quotes the figures measures it.
 */
function checkKitchen(
  doc: DesignDocument,
  level: Level,
  region: Region,
  roomName: string,
  add: (finding: FittingFinding) => void,
): void {
  const inRoom = doc.fixtures.filter(
    (fixture) => fixture.levelId === level.id && pointInPolygon(fixture.at, region.polygon),
  );

  const find = (kinds: readonly string[]): Point2 | null => {
    for (const fixture of inRoom) {
      const entry = getFixture(fixture.fixtureId);
      if (entry && kinds.includes(entry.kind)) return fixture.at;
    }
    return null;
  };

  const sink = find(['sink']);
  const hob = find(['hob', 'oven']);
  const cold = find(['fridge', 'fridge-freezer', 'freezer']);

  /* ---- The triangle ---- */

  if (sink && hob && cold) {
    const legs = [
      { name: 'sink to hob', metres: Math.hypot(sink.x - hob.x, sink.z - hob.z) },
      { name: 'hob to fridge', metres: Math.hypot(hob.x - cold.x, hob.z - cold.z) },
      { name: 'fridge to sink', metres: Math.hypot(cold.x - sink.x, cold.z - sink.z) },
    ];
    const perimeter = legs.reduce((total, leg) => total + leg.metres, 0);

    const short = legs.filter((leg) => leg.metres < KITCHEN_ERGONOMICS.triangleLeg.min);
    const long = legs.filter((leg) => leg.metres > KITCHEN_ERGONOMICS.triangleLeg.max);
    const sprawling = perimeter > KITCHEN_ERGONOMICS.trianglePerimeter.max;

    const problems = [...short, ...long];
    add({
      id: `fit-triangle-${region.key}`,
      severity: problems.length > 0 || sprawling ? 'advice' : 'pass',
      // Deliberately empty: there is no code section for a working triangle,
      // and inventing one would be the worst thing this app could do.
      section: '',
      title:
        problems.length > 0 || sprawling
          ? 'The working triangle is awkward'
          : 'The working triangle works',
      detail:
        problems.length > 0 || sprawling
          ? `${problems
              .map(
                (leg) =>
                  `${leg.name} is ${asFeetInches(leg.metres)}${leg.metres < KITCHEN_ERGONOMICS.triangleLeg.min ? ' (cramped)' : ' (a long walk)'}`,
              )
              .join('; ')}${sprawling ? `${problems.length > 0 ? '; ' : ''}the three legs add to ${asFeetInches(perimeter)}` : ''}. The usual guidance is ${KITCHEN_ERGONOMICS.triangleLeg.asWritten}, with ${KITCHEN_ERGONOMICS.trianglePerimeter.asWritten}. This is ergonomics, not code — a kitchen that fails it is perfectly legal.`
          : `Sink to hob ${asFeetInches(legs[0]!.metres)}, hob to fridge ${asFeetInches(legs[1]!.metres)}, fridge to sink ${asFeetInches(legs[2]!.metres)}, adding to ${asFeetInches(perimeter)}.`,
      remedy:
        problems.length > 0 || sprawling
          ? 'Move the hob or the fridge onto a different run.'
          : '',
      roomName,
    });
  } else if (inRoom.length > 0) {
    const missing = [!sink && 'a sink', !hob && 'a hob or cooker', !cold && 'a fridge']
      .filter(Boolean)
      .join(', ');
    add({
      id: `fit-triangle-missing-${region.key}`,
      severity: 'caution',
      section: '',
      title: 'The working triangle cannot be measured',
      detail: `This kitchen has no ${missing}, so there is no triangle to check. That may be deliberate — a utility room or a kitchenette often has neither.`,
      remedy: 'Place the missing fixtures if the room is meant to be a full kitchen.',
      roomName,
    });
  }

  /* ---- Worktop, and the landings beside the sink and the hob ---- */

  const runsHere = doc.runs.filter(
    (run) => run.levelId === level.id && run.kind === 'base' && runTouches(run.path, region),
  );
  const counter = runsHere.reduce(
    (total, run) => total + counterLines(run).reduce((sum, line) => sum + line.length, 0),
    0,
  );

  if (runsHere.length > 0) {
    const enough = counter >= KITCHEN_ERGONOMICS.totalCounter.min;
    add({
      id: `fit-counter-${region.key}`,
      severity: enough ? 'pass' : 'advice',
      section: '',
      title: enough ? 'There is enough worktop' : 'There is very little worktop',
      detail: `${asFeetInches(counter)} of run, before the sink and the hob are taken out of it. The usual guidance is ${KITCHEN_ERGONOMICS.totalCounter.asWritten}.`,
      remedy: enough ? '' : 'Add a run on another wall, or an island.',
      roomName,
    });
  }
}

/**
 * Whether a run belongs to this room.
 *
 * Tested by stepping a little way OFF the run into the room it faces, not by
 * testing the path itself: a run sits on the room's own wall face, which is
 * exactly the boundary, and a point-in-polygon test on a boundary point is a
 * coin toss.
 */
function runTouches(path: readonly Point2[], region: Region): boolean {
  for (const segment of runSegments(path)) {
    const probe = {
      x: (segment.from.x + segment.to.x) / 2 + segment.normal.x * 0.1,
      z: (segment.from.z + segment.to.z) / 2 + segment.normal.z * 0.1,
    };
    if (pointInPolygon(probe, region.polygon)) return true;
  }
  return false;
}

/* ------------------------------ Ventilation ------------------------------- */

/**
 * IRC R303 — daylight and air.
 *
 * A bathroom with no window needs mechanical extract TO THE OUTSIDE, and the
 * "to the outside" is the half people skip: a fan venting into a roof space is
 * not ventilation, it is a way of putting the moisture somewhere worse.
 */
function checkVentilation(
  doc: DesignDocument,
  level: Level,
  region: Region,
  roomName: string,
  purpose: RoomPurpose,
  add: (finding: FittingFinding) => void,
): void {
  if (purpose !== 'bathroom' && purpose !== 'kitchen') return;

  const hasWindow = roomWalls(level.plan, region).some((wall) => wall.hasWindow);
  const extractor = doc.fixtures.some((fixture) => {
    if (fixture.levelId !== level.id || !pointInPolygon(fixture.at, region.polygon)) return false;
    return getFixture(fixture.fixtureId)?.kind === 'extractor';
  });

  if (purpose === 'kitchen') {
    add({
      id: `fit-m1503-${region.key}`,
      severity: extractor ? 'pass' : 'caution',
      section: IRC_VENTILATION.kitchen.section,
      title: extractor ? 'The kitchen is extracted' : 'The kitchen has no extractor',
      detail: extractor
        ? `An extractor is fitted. IRC ${IRC_VENTILATION.kitchen.section} asks for ${IRC_VENTILATION.kitchen.asWritten}, and whether this one manages it depends on the unit and the duct — neither of which the app knows.`
        : `IRC ${IRC_VENTILATION.kitchen.section} asks for ${IRC_VENTILATION.kitchen.asWritten}. A recirculating hood does not count.`,
      remedy: extractor ? '' : 'Put an extractor over the hob.',
      roomName,
    });
    return;
  }

  add({
    id: `fit-r303-${region.key}`,
    severity: hasWindow || extractor ? 'pass' : 'violation',
    section: IRC_VENTILATION.bathroom.section,
    title:
      hasWindow || extractor
        ? 'The bathroom is ventilated'
        : 'The bathroom has neither a window nor a fan',
    detail:
      hasWindow || extractor
        ? hasWindow
          ? `There is a window. IRC ${IRC_VENTILATION.bathroom.section} allows a window as an alternative to ${IRC_VENTILATION.bathroom.asWritten}.`
          : `A fan is fitted. IRC ${IRC_VENTILATION.bathroom.section} asks for ${IRC_VENTILATION.bathroom.asWritten}, and the duct has to reach the outside.`
        : `IRC ${IRC_VENTILATION.bathroom.section} asks for a window, or ${IRC_VENTILATION.bathroom.asWritten}. A fan venting into a roof space does not count — it puts the moisture somewhere worse.`,
    remedy: hasWindow || extractor ? '' : 'Put a window in, or an extract fan ducted to the outside.',
    roomName,
  });
}
