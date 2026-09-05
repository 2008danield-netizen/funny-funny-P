/**
 * Routing the drainage: the stack, the branches, the falls and the drain out.
 *
 * -----------------------------------------------------------------------------
 * DRAINAGE IS A TREE, AND IT ONLY FLOWS ONE WAY.
 *
 * Every other service in this app is a network you can push through in either
 * direction. Drainage is not. Water leaves a fixture, joins a branch, joins a
 * stack, and leaves the building, and at no point does anything go back up. So
 * the model is a tree with the sewer at its root, and every routing decision is
 * really the same question asked in different places: what does this discharge
 * into, and is there enough height left to get there?
 *
 * That second half is the constraint that makes drainage hard. A branch has to
 * FALL — a quarter-inch per foot for small pipe — so a fixture 8 m from the
 * stack has used 42 mm of height getting there before it starts. Run out of
 * height and there is no pipe you can buy that fixes it; you move the stack or
 * you move the fixture. Which is why this router works backwards from the one
 * fixed elevation in the whole system: the invert of the public sewer.
 *
 * -----------------------------------------------------------------------------
 * HOW IT DECIDES WHERE THE STACK GOES.
 *
 * The stack wants to be close to the water closets, because a WC's branch is
 * the shortest-allowed and least-forgiving pipe in the building, and it wants
 * to be against a wall that exists on every storey it passes through, because
 * a stack that emerges in the middle of a bedroom below is not buildable.
 *
 * So candidates are sampled along the walls of every room that has soil
 * fixtures in it, scored on distance to those fixtures with the WCs weighted
 * heavily, and rejected outright if the point is not inside the building on
 * every storey between the top fixture and the ground.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT WILL NOT DO.
 *
 * It will not route a branch it cannot give the fall to. Same rule as the
 * bathroom layout: drawing a pipe that cannot work, with a warning underneath,
 * teaches people to ignore warnings. It says which fixture it could not
 * connect and how much height it was short.
 */

import { findRegions, pointInPolygon, type Region } from '@/scene/planGraph';
import { roomWalls } from '@/advisor/geometry';
import { roofGeometry, roofHeightAt } from '@/building/roof';
import { elevationOf } from '@/state/levels';
import {
  TRAP_ARMS,
  asDfu,
  branchSizeFor,
  buildingDrainSizeFor,
  minSlopeFor,
} from '@/code/ipc';
import { drainageLoadOf, isSoilFixture, trapSizeOf } from './plumbingSize';
import { getFixture } from '@/fittings/fixtures';
import { PLUMBING_LIMITS, type DesignDocument, type FixtureConnection, type Level, type PipePoint, type PipeRun, type Point2, type SoilStack } from '@/state/types';

/** What a routing pass did, and what it had to assume or give up on. */
export interface RouteResult {
  stacks: number;
  /** Waste and soil branches. Drainage only — supply has its own count. */
  branches: number;
  vents: number;
  /**
   * Hot and cold runs, trunks and branches together.
   *
   * Deliberately NOT folded into `branches`. They were, briefly, and the panel
   * then reported "5 branches, 6 supply runs" for a house with two drainage
   * branches — the same pipes counted under two headings. Two systems, two
   * numbers.
   */
  supplyRuns: number;
  /** Fixtures that ended up actually connected to something. */
  connected: number;
  assumptions: string[];
}

export const emptyRoute = (): RouteResult => ({
  stacks: 0,
  branches: 0,
  vents: 0,
  supplyRuns: 0,
  connected: 0,
  assumptions: [],
});

/** How far the stack stands off the wall it is boxed against. */
const STACK_OFFSET = 0.16;

/** How finely the wall is sampled looking for a stack position. */
const SAMPLE_STEP = 0.25;

/* ------------------------------- Fixture facts ---------------------------- */

/** Every fixture in the building that discharges into a drain. */
export function drainingFixtures(doc: DesignDocument): Array<{
  id: string;
  levelId: string;
  at: Point2;
  soil: boolean;
  trapSize: number;
  dfu: number;
}> {
  const found = [];
  for (const fixture of doc.fixtures) {
    const load = drainageLoadOf(fixture.fixtureId);
    if (!load) continue;
    found.push({
      id: fixture.id,
      levelId: fixture.levelId,
      at: fixture.at,
      soil: isSoilFixture(fixture.fixtureId),
      trapSize: trapSizeOf(fixture.fixtureId),
      dfu: load.dfu,
    });
  }
  return found;
}

/** Every fixture that draws hot or cold water. */
export function suppliedFixtures(doc: DesignDocument): Array<{
  id: string;
  levelId: string;
  at: Point2;
  cold: boolean;
  hot: boolean;
}> {
  const found = [];
  for (const fixture of doc.fixtures) {
    const entry = getFixture(fixture.fixtureId);
    if (!entry) continue;
    if (!entry.connections.hot && !entry.connections.cold) continue;
    found.push({
      id: fixture.id,
      levelId: fixture.levelId,
      at: fixture.at,
      cold: entry.connections.cold,
      hot: entry.connections.hot,
    });
  }
  return found;
}

/* ------------------------------ Where things are -------------------------- */

/** The regions of one storey, cached per call so the plan is walked once. */
function regionsOf(level: Level): Region[] {
  return findRegions(level.plan);
}

/** Whether a plan point falls inside any room on this storey. */
function insideLevel(regions: readonly Region[], point: Point2): boolean {
  return regions.some((region) => pointInPolygon(point, region.polygon));
}

/**
 * The storeys a stack has to pass through, bottom to top.
 *
 * From the lowest storey in the building up to the highest one with a draining
 * fixture on it. The stack must exist on all of them — it cannot start on the
 * first floor and materialise below.
 */
function stackLevels(doc: DesignDocument): Level[] {
  const draining = new Set(drainingFixtures(doc).map((fixture) => fixture.levelId));
  let top = 0;
  doc.levels.forEach((level, index) => {
    if (draining.has(level.id)) top = Math.max(top, index);
  });
  return doc.levels.slice(0, top + 1);
}

/**
 * Where to put the stack.
 *
 * Scored, not guessed. Every wall of every room that contains a draining
 * fixture contributes candidate points at 250 mm intervals, offset off the wall
 * by the thickness of the boxing it will need. A candidate is disqualified if
 * it is not inside the building on every storey the stack must pass through —
 * that single test is what stops a stack appearing in mid-air over a
 * single-storey extension.
 *
 * The score is total branch length, with water closets counted four times over.
 * A WC branch is 3 in pipe with a 12 ft limit on its trap arm and no tolerance
 * for a long run; a basin will happily go twice as far.
 */
export function stackSpot(doc: DesignDocument): { at: Point2; wallId: string | null } | null {
  const fixtures = drainingFixtures(doc);
  if (fixtures.length === 0) return null;

  const levels = stackLevels(doc);
  if (levels.length === 0) return null;

  const regionsByLevel = new Map(doc.levels.map((level) => [level.id, regionsOf(level)]));

  let best: { at: Point2; wallId: string | null; score: number } | null = null;

  for (const level of levels) {
    const regions = regionsByLevel.get(level.id) ?? [];
    const here = fixtures.filter((fixture) => fixture.levelId === level.id);
    if (here.length === 0) continue;

    for (const region of regions) {
      // Only rooms that actually contain something draining.
      const inRoom = here.filter((fixture) => pointInPolygon(fixture.at, region.polygon));
      if (inRoom.length === 0) continue;

      for (const wall of roomWalls(level.plan, region)) {
        const steps = Math.max(1, Math.floor(wall.length / SAMPLE_STEP));
        for (let step = 0; step <= steps; step += 1) {
          const t = steps === 0 ? 0.5 : step / steps;

          // Not in a doorway: a stack across an opening cannot be boxed in.
          const along = t * wall.length;
          const blocked = wall.openingSpans.some(
            (span) => along > span.from - 0.3 && along < span.to + 0.3,
          );
          if (blocked) continue;

          const face = {
            x: wall.faceStart.x + (wall.faceEnd.x - wall.faceStart.x) * t,
            z: wall.faceStart.z + (wall.faceEnd.z - wall.faceStart.z) * t,
          };
          const at = {
            x: face.x + wall.inward.x * STACK_OFFSET,
            z: face.z + wall.inward.z * STACK_OFFSET,
          };

          // Must be inside the building on every storey it passes through.
          const passable = levels.every((other) =>
            insideLevel(regionsByLevel.get(other.id) ?? [], at),
          );
          if (!passable) continue;

          let score = 0;
          for (const fixture of fixtures) {
            const distance = Math.hypot(fixture.at.x - at.x, fixture.at.z - at.z);
            score += distance * (fixture.soil ? 4 : 1);
          }

          if (!best || score < best.score) best = { at, wallId: wall.wallId, score };
        }
      }
    }
  }

  return best ? { at: best.at, wallId: best.wallId } : null;
}

/* -------------------------------- Routing --------------------------------- */

/**
 * An L-shaped route from a fixture to the stack, kept inside the building.
 *
 * Pipe runs along a joist and then turns; it does not go diagonally across a
 * floor. So there are exactly two candidate paths — across then along, or along
 * then across — and the one whose corner stays inside the building wins. When
 * both are inside, the one whose corner is furthest from the room's other
 * fixtures wins, because that is the one least likely to want a notch through
 * something.
 */
function elbowRoute(from: Point2, to: Point2, regions: readonly Region[]): Point2[] {
  const candidates: Point2[] = [
    { x: to.x, z: from.z },
    { x: from.x, z: to.z },
  ];

  const usable = candidates.filter((corner) => insideLevel(regions, corner));
  const corner = usable[0] ?? candidates[0]!;

  // A corner that coincides with either end is not a corner.
  const points: Point2[] = [from];
  if (
    Math.hypot(corner.x - from.x, corner.z - from.z) > 0.05 &&
    Math.hypot(corner.x - to.x, corner.z - to.z) > 0.05
  ) {
    points.push(corner);
  }
  points.push(to);
  return points;
}

/** Total plan length of a polyline. */
function planLength(points: readonly Point2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
  }
  return total;
}

/**
 * Turns a plan route into pipe points that fall the whole way.
 *
 * Height is distributed by distance travelled rather than by vertex, so a route
 * whose first leg is 3 m and second 0.5 m falls proportionately along each —
 * which is what a real pipe laid to a constant gradient does, and what makes
 * the slope check on the finished run come out to exactly the figure asked for
 * rather than an average of two different gradients.
 */
function fallingPoints(
  levelId: string,
  plan: readonly Point2[],
  startHeight: number,
  slope: number,
): PipePoint[] {
  let travelled = 0;
  const points: PipePoint[] = [];

  for (let i = 0; i < plan.length; i += 1) {
    if (i > 0) {
      travelled += Math.hypot(plan[i]!.x - plan[i - 1]!.x, plan[i]!.z - plan[i - 1]!.z);
    }
    points.push({ levelId, at: plan[i]!, height: startHeight - travelled * slope });
  }

  return points;
}

/* ------------------------------ The whole pass ---------------------------- */

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}${counter}`;
};

/** Restarts pipe ids, so a test gets the same ids twice. */
export function resetPlumbingIds(): void {
  counter = 0;
}

/**
 * Routes the whole building's drainage.
 *
 * Works from the sewer upward:
 *   1. Fix the stack position.
 *   2. Work out the invert at the foot of the stack by running the building
 *      drain back from the sewer at its minimum fall.
 *   3. Hang every branch off the stack at the height its own storey allows.
 *   4. Carry the stack up through the roof as the vent, and revent any fixture
 *      whose trap arm is too long to be protected by the stack alone.
 *
 * Runs the user has marked `manual` are left exactly where they are — the whole
 * point of being able to move a pipe is that re-routing does not undo it.
 */
export function routeDrainage(doc: DesignDocument): RouteResult {
  const result = emptyRoute();
  const fixtures = drainingFixtures(doc);

  if (fixtures.length === 0) {
    result.assumptions.push(
      'Nothing in this building drains — no sink, bath or WC has been placed — so there was nothing to route. Lay out a kitchen or a bathroom first.',
    );
    return result;
  }

  const spot = stackSpot(doc);
  if (!spot) {
    result.assumptions.push(
      'There is nowhere to put a soil stack: no wall in a room with a draining fixture is inside the building on every storey the stack has to pass through. Move a fixture, or add the room below it.',
    );
    return result;
  }

  const manual = doc.plumbing.drainage.filter((run) => run.manual);
  const keptIds = new Set(manual.map((run) => run.id));

  const levels = stackLevels(doc);
  const bottom = levels[0]!;
  const top = levels[levels.length - 1]!;

  /* ---- 1. The building drain, worked back from the sewer ---- */

  const sewer = doc.site.sewerConnection;
  const sewerAt = sewer?.at ?? assumedSewerPoint(doc, spot.at);
  const sewerDepth = sewer?.invertDepth ?? PLUMBING_LIMITS.defaultInvertDepth;

  if (!sewer) {
    result.assumptions.push(
      `No sewer connection has been placed on the plot, so one was assumed at the nearest boundary, ${sewerDepth.toFixed(2)} m below the ground floor. Place the real one on the site plan — every fall in the building is measured back from it, and a sewer 300 mm shallower can make a whole layout unbuildable.`,
    );
  }

  // Size the drain first so its own minimum fall is the one used.
  const totalDfu = asDfu(fixtures.reduce((sum, fixture) => sum + fixture.dfu, 0));
  const waterClosets = fixtures.filter((fixture) => fixture.soil).length;
  const drainSize = buildingDrainSizeFor(totalDfu, waterClosets);
  const drainSlope = minSlopeFor(drainSize.size).minSlope;

  const drainPlan = [spot.at, sewerAt];
  const drainLength = planLength(drainPlan);
  // Work backwards: the stack's foot must be this much ABOVE the sewer invert.
  const stackFootHeight = -sewerDepth + drainLength * drainSlope;

  const buildingDrain: PipeRun = {
    id: nextId('pd'),
    system: 'soil',
    points: [
      { levelId: bottom.id, at: spot.at, height: stackFootHeight },
      { levelId: bottom.id, at: sewerAt, height: -sewerDepth },
    ],
    serves: [],
    downstreamId: null,
    manual: false,
  };

  /* ---- 2. The stack itself ---- */

  const stack: SoilStack = {
    id: nextId('st'),
    at: spot.at,
    fromLevelId: bottom.id,
    toLevelId: top.id,
    ventAboveRoof: PLUMBING_LIMITS.defaultVentAboveRoof,
    wallId: spot.wallId,
  };

  const stackTopHeight = top.wallHeight;
  const stackRun: PipeRun = {
    id: nextId('ps'),
    system: 'soil',
    points: [
      { levelId: bottom.id, at: spot.at, height: stackFootHeight },
      { levelId: top.id, at: spot.at, height: stackTopHeight },
    ],
    serves: [],
    downstreamId: buildingDrain.id,
    manual: false,
  };

  const runs: PipeRun[] = [buildingDrain, stackRun];
  const connections: FixtureConnection[] = [];
  const unreachable: string[] = [];

  /* ---- 3. A branch per fixture ---- */

  const regionsByLevel = new Map(doc.levels.map((level) => [level.id, regionsOf(level)]));

  for (const fixture of fixtures) {
    const level = doc.levels.find((candidate) => candidate.id === fixture.levelId);
    if (!level) continue;

    const regions = regionsByLevel.get(level.id) ?? [];
    const plan = elbowRoute(fixture.at, spot.at, regions);
    const length = planLength(plan);

    // Size the branch on its own load, then take that size's minimum fall.
    const size = branchSizeFor(asDfu(fixture.dfu), fixture.soil);
    const trapSize = Math.max(fixture.trapSize, size.size);
    const slope = minSlopeFor(trapSize).minSlope;

    /*
     * Where the branch starts. A trap sits just under the fixture; the pipe
     * then drops into the floor void and runs. Starting the fall from the void
     * rather than from the trap is what leaves the trap arm its own short
     * length of fall, which IPC 906.1 requires separately.
     */
    const startHeight = -PLUMBING_LIMITS.floorVoidDepth;
    const arrival = startHeight - length * slope;

    /*
     * The branch has to arrive at the stack ABOVE the stack's foot, or there is
     * nothing for it to fall into. On the bottom storey with a deep run that is
     * a real failure, and it is reported rather than drawn.
     */
    const levelBase = elevationOf(doc, level.id);
    const arrivalWorld = levelBase + arrival;
    const footWorld = elevationOf(doc, bottom.id) + stackFootHeight;

    if (arrivalWorld <= footWorld + 0.02) {
      const short = footWorld + 0.02 - arrivalWorld;
      unreachable.push(
        `${nameOf(doc, fixture.id)} is ${length.toFixed(1)} m from the stack, which at ${size.asWritten} pipe needs ${(length * slope * 1000).toFixed(0)} mm of fall — about ${(short * 1000).toFixed(0)} mm more than there is above the drain. Move it nearer the stack, move the stack, or get the sewer connection deeper.`,
      );
      continue;
    }

    const branch: PipeRun = {
      id: nextId('pb'),
      system: fixture.soil ? 'soil' : 'waste',
      points: fallingPoints(level.id, plan, startHeight, slope),
      serves: [fixture.id],
      downstreamId: stackRun.id,
      manual: false,
    };
    runs.push(branch);

    connections.push({
      fixtureId: fixture.id,
      trapAt: fixture.at,
      trapHeight: fixture.soil ? 0.1 : 0.35,
      trapSize: fixture.trapSize,
      drainRunId: branch.id,
      // Filled in below, once it is known whether the stack alone protects it.
      ventRunId: null,
      coldRunId: null,
      hotRunId: null,
    });
  }

  /* ---- 4. The vent, up the stack and out through the roof ---- */

  const roofHeight = roofTopAt(doc, top, spot.at) + stack.ventAboveRoof;
  const stackVent: PipeRun = {
    id: nextId('pv'),
    system: 'vent',
    points: [
      { levelId: top.id, at: spot.at, height: stackTopHeight },
      { levelId: top.id, at: spot.at, height: roofHeight - elevationOf(doc, top.id) },
    ],
    serves: [],
    downstreamId: stackRun.id,
    manual: false,
  };
  runs.push(stackVent);

  /*
   * Anything whose trap arm is longer than Table 906.1 allows needs a vent of
   * its own, taken off the branch and carried up to join the stack vent above
   * the highest flood level. Everything else is protected by the stack.
   */
  let reventCount = 0;
  for (const connection of connections) {
    const branch = runs.find((run) => run.id === connection.drainRunId);
    if (!branch) continue;

    const armLength = planLength(branch.points.map((point) => point.at));
    const arm = trapArmLimit(connection.trapSize);

    if (armLength <= arm.maxLength) {
      connection.ventRunId = stackVent.id;
      continue;
    }

    const level = doc.levels.find((candidate) => candidate.id === branch.points[0]!.levelId);
    const start = branch.points[0]!;
    const revent: PipeRun = {
      id: nextId('pv'),
      system: 'vent',
      points: [
        { levelId: start.levelId, at: start.at, height: start.height },
        {
          levelId: start.levelId,
          at: start.at,
          height: (level?.wallHeight ?? 2.4) - 0.2,
        },
        {
          levelId: start.levelId,
          at: spot.at,
          height: (level?.wallHeight ?? 2.4) - 0.2,
        },
      ],
      serves: [connection.fixtureId],
      downstreamId: branch.id,
      manual: false,
    };
    runs.push(revent);
    connection.ventRunId = revent.id;
    reventCount += 1;
  }

  if (reventCount > 0) {
    result.assumptions.push(
      `${reventCount} fixture${reventCount === 1 ? '' : 's'} sat further from the stack than IPC Table 906.1 lets a trap arm run, so ${reventCount === 1 ? 'it was' : 'they were'} given a vent of their own back to the stack vent. That is legitimate and common, but a shorter branch is cheaper — moving the fixture closer removes the pipe entirely.`,
    );
  }

  /* ---- Commit ---- */

  doc.plumbing.stacks = [stack];
  doc.plumbing.drainage = [...manual, ...runs.filter((run) => !keptIds.has(run.id))];
  // Supply connections are re-attached by the supply router; drainage owns the
  // rest of the record, so it merges rather than overwrites.
  const existing = new Map(doc.plumbing.connections.map((entry) => [entry.fixtureId, entry]));
  doc.plumbing.connections = connections.map((entry) => ({
    ...entry,
    coldRunId: existing.get(entry.fixtureId)?.coldRunId ?? null,
    hotRunId: existing.get(entry.fixtureId)?.hotRunId ?? null,
  }));

  result.stacks = 1;
  result.branches = runs.filter((run) => run.system !== 'vent').length - 2;
  result.vents = runs.filter((run) => run.system === 'vent').length;
  result.connected = connections.length;

  for (const note of unreachable) result.assumptions.push(note);

  if (connections.length > 0) {
    result.assumptions.push(
      `Pipe sizes and falls are worked out from the fixtures actually placed, to the 2021 IPC. Every horizontal run is drawn at the minimum fall its size allows — a real installation usually has more to play with, and more fall is better than less right up to about 1 in 12. ${drainSize.asWritten} building drain at ${minSlopeFor(drainSize.size).asWritten}.`,
    );
  }

  return result;
}

/* -------------------------------- Helpers --------------------------------- */

/** A fixture's name, for a message a person reads. */
function nameOf(doc: DesignDocument, fixtureId: string): string {
  const fixture = doc.fixtures.find((candidate) => candidate.id === fixtureId);
  const entry = fixture ? getFixture(fixture.fixtureId) : null;
  return entry?.name ?? 'A fixture';
}

/** Table 906.1's limit for a trap arm of this size. */
function trapArmLimit(size: number): { maxLength: number; maxAsWritten: string } {
  const rule =
    TRAP_ARMS.find((entry) => size <= entry.size + 1e-9) ?? TRAP_ARMS[TRAP_ARMS.length - 1]!;
  return { maxLength: rule.maxLength, maxAsWritten: rule.maxAsWritten };
}

/**
 * Where to assume the sewer is, when nobody has placed one.
 *
 * The nearest point on the plot boundary, or failing that a point 8 m from the
 * stack — which is roughly a front garden. Both are guesses and the caller says
 * so; the point of picking a real boundary point rather than an arbitrary
 * offset is that the drain length is then at least the right order, so the fall
 * arithmetic produces a plausible answer rather than a trivially easy one.
 */
function assumedSewerPoint(doc: DesignDocument, from: Point2): Point2 {
  const boundary = doc.site.boundary;
  if (boundary.length >= 2) {
    let best: { at: Point2; distance: number } | null = null;
    for (let i = 0; i < boundary.length; i += 1) {
      const a = boundary[i]!;
      const b = boundary[(i + 1) % boundary.length]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSquared = dx * dx + dz * dz;
      if (lengthSquared < 1e-9) continue;
      const t = Math.max(
        0,
        Math.min(1, ((from.x - a.x) * dx + (from.z - a.z) * dz) / lengthSquared),
      );
      const at = { x: a.x + dx * t, z: a.z + dz * t };
      const distance = Math.hypot(at.x - from.x, at.z - from.z);
      if (!best || distance < best.distance) best = { at, distance };
    }
    if (best) return best.at;
  }
  return { x: from.x, z: from.z + 8 };
}

/**
 * How high the roof is where the stack comes through it.
 *
 * The real roof surface, not an estimate: `roofHeightAt` gives the height of
 * the plane directly above the stack, which is exactly the point the vent has
 * to clear. Approximating it would put the vent through the wrong part of a
 * hipped roof, and the 904.5 check — is this vent 10 ft clear of a window —
 * would then be measured from the wrong place.
 *
 * Falls back to the top of the wall when the stack is not under a roof at all,
 * which happens on a plan whose roof has not been generated yet.
 */
function roofTopAt(doc: DesignDocument, top: Level, at: Point2): number {
  const base = elevationOf(doc, top.id) + top.wallHeight;

  for (const roof of doc.roofs) {
    if (roof.overLevelId !== top.id) continue;
    const geometry = roofGeometry(doc, roof);
    if (!geometry) continue;
    const height = roofHeightAt(geometry, at);
    if (height !== null) return Math.max(base, height);
  }
  return base;
}
