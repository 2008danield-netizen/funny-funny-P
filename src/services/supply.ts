/**
 * Routing the water supply: the service, the heater, and the hot and cold trees.
 *
 * -----------------------------------------------------------------------------
 * THE OPPOSITE PROBLEM TO DRAINAGE.
 *
 * A drain is a tree that flows DOWN under gravity, and its constraint is
 * height. A supply is a tree that flows UP under pressure, and its constraint
 * is pressure. Nothing about the geometry is hard — supply pipe is small, it
 * runs wherever there is room, and it does not care about fall. What is hard is
 * arriving at the last shower in the house with enough pressure left to work.
 *
 * So this router does the geometry quickly and the arithmetic carefully. It
 * lays a trunk from the service entry to the water heater, then a cold tree and
 * a hot tree out to the fixtures, and the checker walks the longest path
 * through those trees subtracting friction and static head until it finds out
 * what is left at the worst outlet.
 *
 * -----------------------------------------------------------------------------
 * WHY A TREE AND NOT A MANIFOLD.
 *
 * Two ways to plumb a house. A TRUNK AND BRANCH tree — one main with tees off
 * it — is what most houses have and what the fixture-unit tables are written
 * for. A MANIFOLD gives every fixture its own small pipe from a central block,
 * which wastes less water and behaves better, but sizes by a different method
 * entirely.
 *
 * This routes trunk and branch, because that is what the IPC's Appendix E
 * sizes and what the checker can therefore verify. A manifold layout would
 * need its own sizing rules, and inventing them is worse than not offering it.
 */

import { findRegions, pointInPolygon, type Region } from '@/scene/planGraph';
import { elevationOf } from '@/state/levels';
import { roomPurpose } from './rooms';
import { resolveRoomSpec } from '@/state/planOps';
import { HOT_WATER, asWsfu, serviceSizeFor } from '@/code/ipc';
import { supplyLoadOf } from './plumbingSize';
import { suppliedFixtures, emptyRoute, type RouteResult } from './drainage';
import {
  PLUMBING_LIMITS,
  type DesignDocument,
  type Level,
  type PipePoint,
  type PipeRun,
  type Point2,
  type WaterHeater,
} from '@/state/types';

/** Where supply pipe runs when it is not dropping down a wall to a tap. */
const RUN_HEIGHT = PLUMBING_LIMITS.supplyHeight;

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}${counter}`;
};

export function resetSupplyIds(): void {
  counter = 0;
}

/* ------------------------------ The heater -------------------------------- */

/**
 * Where the water heater goes, and how big it is.
 *
 * Position: a utility room if the plan names one, otherwise the room with the
 * kitchen sink in it, otherwise the largest room on the ground floor. Every one
 * of those is somewhere a heater plausibly lives, and the ordering is by how
 * confident the guess is.
 *
 * Size: the rule of thumb, and labelled as one. The IPC requires a heater sized
 * for the demand (501.1) and does not say how — so there is no section to cite
 * and the finding says "guidance" rather than quoting a number as if it were
 * code.
 */
export function placeHeater(doc: DesignDocument): WaterHeater | null {
  const ground = doc.levels[0];
  if (!ground) return null;

  const bathrooms = countBathrooms(doc);
  const litres = storageFor(bathrooms);

  const spot = heaterSpot(ground);
  if (!spot) return null;

  return {
    id: nextId('wh'),
    kind: 'storage',
    levelId: ground.id,
    at: spot,
    litres,
    recirculation: false,
  };
}

/** How many rooms in the building are bathrooms. */
export function countBathrooms(doc: DesignDocument): number {
  let count = 0;
  for (const level of doc.levels) {
    for (const region of findRegions(level.plan)) {
      const spec = resolveRoomSpec(level.plan, region.key);
      if (roomPurpose(spec.name) === 'bathroom') count += 1;
    }
  }
  return count;
}

/**
 * Storage volume for this many bathrooms, rounded up to a size you can buy.
 *
 * Guidance, not code. A base allowance plus a figure per bathroom is the
 * ordinary merchant's rule, and rounding to a real cylinder size is what stops
 * the app specifying a 187-litre tank that nobody makes.
 */
export function storageFor(bathrooms: number): number {
  const wanted = HOT_WATER.litresBase + Math.max(1, bathrooms) * HOT_WATER.litresPerBathroom;
  return HOT_WATER.storageSizes.find((size) => size >= wanted) ?? HOT_WATER.storageSizes[HOT_WATER.storageSizes.length - 1]!;
}

/** A plausible spot for the heater, in decreasing order of confidence. */
function heaterSpot(ground: Level): Point2 | null {
  const regions = findRegions(ground.plan);
  if (regions.length === 0) return null;

  const named = (purposes: readonly string[]): Region | undefined =>
    regions.find((region) => {
      const spec = resolveRoomSpec(ground.plan, region.key);
      return purposes.includes(roomPurpose(spec.name));
    });

  const room =
    named(['utility']) ??
    named(['kitchen']) ??
    [...regions].sort((a, b) => areaOf(b.polygon) - areaOf(a.polygon))[0];

  if (!room) return null;

  // A corner of the room rather than the middle of it: a cylinder against a
  // wall is what a real one does, and it keeps the floor usable.
  return cornerOf(room.polygon);
}

function areaOf(polygon: readonly Point2[]): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    total += a.x * b.z - b.x * a.z;
  }
  return Math.abs(total) / 2;
}

/** A point tucked into the room's tightest corner, 400 mm off both walls. */
function cornerOf(polygon: readonly Point2[]): Point2 {
  let best: { at: Point2; score: number } | null = null;
  for (const vertex of polygon) {
    const inward = centroid(polygon);
    const toCentre = { x: inward.x - vertex.x, z: inward.z - vertex.z };
    const length = Math.hypot(toCentre.x, toCentre.z) || 1;
    const at = {
      x: vertex.x + (toCentre.x / length) * 0.5,
      z: vertex.z + (toCentre.z / length) * 0.5,
    };
    if (!pointInPolygon(at, polygon)) continue;
    const score = Math.hypot(at.x - inward.x, at.z - inward.z);
    if (!best || score > best.score) best = { at, score };
  }
  return best?.at ?? centroid(polygon);
}

function centroid(polygon: readonly Point2[]): Point2 {
  let x = 0;
  let z = 0;
  for (const point of polygon) {
    x += point.x;
    z += point.z;
  }
  return { x: x / (polygon.length || 1), z: z / (polygon.length || 1) };
}

/* ------------------------------- The routing ------------------------------ */

/**
 * Routes the supply for the whole building.
 *
 * The shape is a spine and ribs, which is what trunk-and-branch means in
 * practice:
 *
 *   • A SERVICE from the plot boundary to the heater — the only cold pipe that
 *     carries the whole building's load.
 *   • A COLD TRUNK from the service tee, and a HOT TRUNK from the heater,
 *     both running to a point central to the fixtures on each storey.
 *   • A BRANCH from the nearest trunk to each fixture.
 *
 * Sizes are not stored. Every pipe here is sized from its accumulated WSFU by
 * `plumbingSize.ts`, so a bath added upstairs re-sizes the trunk under it
 * without anything being re-routed.
 */
export function routeSupply(doc: DesignDocument): RouteResult {
  const result = emptyRoute();
  const fixtures = suppliedFixtures(doc);

  if (fixtures.length === 0) {
    result.assumptions.push(
      'Nothing in this building draws water, so there was nothing to route. Lay out a kitchen or a bathroom first.',
    );
    return result;
  }

  const ground = doc.levels[0];
  if (!ground) return result;

  const heater = doc.plumbing.heater ?? placeHeater(doc);
  if (!heater) {
    result.assumptions.push(
      'There is no room on the ground floor to stand a water heater in, so none was placed and no hot water was routed.',
    );
    return result;
  }

  const manual = doc.plumbing.supply.filter((run) => run.manual);
  const keptIds = new Set(manual.map((run) => run.id));
  const runs: PipeRun[] = [];

  /* ---- The service, from the plot to the heater ---- */

  const entry = doc.site.waterService?.at ?? assumedServicePoint(doc, heater.at);
  if (!doc.site.waterService) {
    result.assumptions.push(
      'No water service point has been placed on the plot, so one was assumed at the nearest boundary. The distance from there to the furthest tap is what the pressure check is measured along, so a real position matters — a service 20 m longer than assumed can be the difference between a working shower and a trickle.',
    );
  }

  const service: PipeRun = {
    id: nextId('sv'),
    system: 'cold',
    points: [
      { levelId: ground.id, at: entry, height: -PLUMBING_LIMITS.floorVoidDepth },
      { levelId: ground.id, at: heater.at, height: RUN_HEIGHT },
    ],
    /*
     * No fixtures of its own. The service carries the whole building's load
     * anyway, because every trunk — hot as well as cold — names it downstream,
     * and the accumulator walks that chain. That is not a quirk: the service is
     * the one pipe that genuinely carries the hot demand too, since the water
     * reaches the heater through it.
     */
    serves: [],
    downstreamId: null,
    manual: false,
  };
  runs.push(service);

  /* ---- A cold and a hot trunk per storey ---- */

  const trunks = new Map<string, { cold: PipeRun; hot: PipeRun }>();

  for (const level of doc.levels) {
    const here = fixtures.filter((fixture) => fixture.levelId === level.id);
    if (here.length === 0) continue;

    // The trunk runs from directly above the heater to the middle of what it
    // serves, which is the shortest pipe that reaches everything on the storey.
    const target = centroid(here.map((fixture) => fixture.at));

    const spine = (system: 'cold' | 'hot'): PipeRun => ({
      id: nextId(system === 'cold' ? 'sc' : 'sh'),
      system,
      points: [
        { levelId: ground.id, at: heater.at, height: RUN_HEIGHT },
        { levelId: level.id, at: heater.at, height: RUN_HEIGHT },
        { levelId: level.id, at: target, height: RUN_HEIGHT },
      ].filter(
        // A trunk on the ground floor has no vertical leg, and a duplicated
        // point would read as a zero-length pipe in every schedule.
        (point, index, all) =>
          index === 0 ||
          point.levelId !== all[index - 1]!.levelId ||
          Math.hypot(point.at.x - all[index - 1]!.at.x, point.at.z - all[index - 1]!.at.z) > 1e-6,
      ) as PipePoint[],
      serves: [],
      downstreamId: service.id,
      manual: false,
    });

    const cold = spine('cold');
    const hot = spine('hot');
    // Hot leaves the heater; cold tees off the service before it.
    runs.push(cold, hot);
    trunks.set(level.id, { cold, hot });
  }

  /* ---- A branch to each fixture ---- */

  let branches = 0;
  const connections = new Map(doc.plumbing.connections.map((entry) => [entry.fixtureId, entry]));

  for (const fixture of fixtures) {
    const trunk = trunks.get(fixture.levelId);
    if (!trunk) continue;

    const from = trunk.cold.points[trunk.cold.points.length - 1]!;
    let coldId: string | null = null;
    let hotId: string | null = null;

    if (fixture.cold) {
      const run: PipeRun = {
        id: nextId('sc'),
        system: 'cold',
        points: [
          { levelId: fixture.levelId, at: from.at, height: RUN_HEIGHT },
          { levelId: fixture.levelId, at: fixture.at, height: RUN_HEIGHT },
          { levelId: fixture.levelId, at: fixture.at, height: 0.6 },
        ],
        serves: [fixture.id],
        downstreamId: trunk.cold.id,
        manual: false,
      };
      runs.push(run);
      coldId = run.id;
      branches += 1;
    }

    if (fixture.hot) {
      const hotFrom = trunk.hot.points[trunk.hot.points.length - 1]!;
      const run: PipeRun = {
        id: nextId('sh'),
        system: 'hot',
        points: [
          { levelId: fixture.levelId, at: hotFrom.at, height: RUN_HEIGHT },
          { levelId: fixture.levelId, at: fixture.at, height: RUN_HEIGHT },
          { levelId: fixture.levelId, at: fixture.at, height: 0.6 },
        ],
        serves: [fixture.id],
        downstreamId: trunk.hot.id,
        manual: false,
      };
      runs.push(run);
      hotId = run.id;
      branches += 1;
    }

    const existing = connections.get(fixture.id);
    connections.set(fixture.id, {
      fixtureId: fixture.id,
      trapAt: existing?.trapAt ?? fixture.at,
      trapHeight: existing?.trapHeight ?? 0.35,
      trapSize: existing?.trapSize ?? 0.04,
      drainRunId: existing?.drainRunId ?? null,
      ventRunId: existing?.ventRunId ?? null,
      coldRunId: coldId,
      hotRunId: hotId,
    });
  }

  /* ---- Should it recirculate? ---- */

  const furthest = furthestHotRun(doc, heater.at, fixtures);
  const recirculation = furthest > HOT_WATER.recirculationBeyond;
  if (recirculation) {
    result.assumptions.push(
      `The furthest hot tap is about ${furthest.toFixed(0)} m of pipe from the heater, which is a long wait at the tap and a lot of water down the drain each time. A flow-and-return loop has been specified. This is guidance rather than code — the IPC does not require one.`,
    );
  }

  /* ---- Commit ---- */

  doc.plumbing.heater = { ...heater, recirculation };
  doc.plumbing.supply = [...manual, ...runs.filter((run) => !keptIds.has(run.id))];
  doc.plumbing.connections = [...connections.values()];

  result.supplyRuns = runs.length;
  result.branches = branches;
  result.connected = connections.size;

  const load = doc.fixtures.reduce((sum, fixture) => {
    const entry = supplyLoadOf(fixture.fixtureId);
    return sum + (entry?.total ?? 0);
  }, 0);

  result.assumptions.push(
    `Sized for ${load.toFixed(1)} water supply fixture units, which is a ${serviceSizeFor(asWsfu(load)).asWritten} service on the tables. The pressure check then re-does it properly from the street pressure and the length of the run, and where the two disagree the pressure calculation wins.`,
  );

  return result;
}

/** How far the furthest hot fixture is from the heater, along the pipe. */
function furthestHotRun(
  doc: DesignDocument,
  heaterAt: Point2,
  fixtures: ReadonlyArray<{ levelId: string; at: Point2; hot: boolean }>,
): number {
  let furthest = 0;
  for (const fixture of fixtures) {
    if (!fixture.hot) continue;
    const rise = Math.abs(elevationOf(doc, fixture.levelId));
    const plan = Math.hypot(fixture.at.x - heaterAt.x, fixture.at.z - heaterAt.z);
    furthest = Math.max(furthest, plan + rise);
  }
  return furthest;
}

/**
 * Where to assume the water service enters, when nobody has placed a point.
 *
 * The nearest point on the plot boundary to the heater — the same reasoning as
 * the assumed sewer point: a guess that is at least the right order of length,
 * so the pressure arithmetic produces a plausible answer instead of a trivially
 * easy one.
 */
function assumedServicePoint(doc: DesignDocument, from: Point2): Point2 {
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
