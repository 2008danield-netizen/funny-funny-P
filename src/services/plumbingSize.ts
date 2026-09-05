/**
 * Sizing the pipework: fixture units in, diameters out.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE, AND WHY NOTHING STORES A PIPE SIZE.
 *
 * Three things need to know how big a pipe is: the router (to draw it at the
 * right diameter and work out its fall), the renderer, and the checker. If any
 * two of them carried their own copy of the arithmetic they would eventually
 * disagree, and the disagreement would look like a drawing that passes its own
 * checks while showing the wrong pipe.
 *
 * So the size is computed here, once, and everything asks. Nothing stores it.
 * A stored diameter is a diameter that is right when it is written and wrong
 * the moment a bath is added upstream of it — and an undersized drain does not
 * announce itself, it just backs up in five years.
 *
 * -----------------------------------------------------------------------------
 * LOADS ACCUMULATE DOWNSTREAM.
 *
 * The load on a pipe is not what the fixtures on it discharge — it is what
 * everything above it discharges. A branch serving one basin carries 1 DFU; the
 * stack it joins carries that basin plus every other fixture in the building.
 *
 * The runs form a tree pointing downstream (`downstreamId`), so the total on
 * any run is found by walking each run's own fixtures down the chain and adding
 * them to everything they pass through. That is O(runs × depth), which for a
 * house is nothing, and it is far easier to be sure of than an upstream walk.
 */

import {
  DRAINAGE_LOADS,
  SUPPLY_LOADS,
  asDfu,
  asWsfu,
  branchSizeFor,
  buildingDrainSizeFor,
  minSlopeFor,
  nearestDrainSize,
  stackSizeFor,
  serviceSizeFor,
  supplySizeFor,
  ventSizeFor,
  type DrainSize,
  type Dfu,
  type DrainageLoad,
  type SupplyLoad,
  type SupplySize,
  type Wsfu,
} from '@/code/ipc';
import { getFixture } from '@/fittings/fixtures';
import { elevationOf } from '@/state/levels';
import type { DesignDocument, PipePoint, PipeRun } from '@/state/types';

/* ----------------------------- Fixture lookups ---------------------------- */

/**
 * What this fixture loads the drain with.
 *
 * Goes through the catalogue rather than being keyed on the fixture id, so a
 * new bath added to `fittings/fixtures.ts` is loaded correctly the moment it
 * declares its kind — there is no second table to remember to update.
 *
 * Null for anything that does not drain. A fridge has no DFU, and giving it
 * zero rather than nothing would let it silently appear on a drain schedule.
 */
export function drainageLoadOf(fixtureId: string): DrainageLoad | null {
  const entry = getFixture(fixtureId);
  if (!entry) return null;
  if (!entry.connections.soil && entry.connections.waste === null) return null;
  return DRAINAGE_LOADS[entry.kind] ?? null;
}

/** What this fixture draws, in water supply fixture units. Null if it has no tap. */
export function supplyLoadOf(fixtureId: string): SupplyLoad | null {
  const entry = getFixture(fixtureId);
  if (!entry) return null;
  if (!entry.connections.hot && !entry.connections.cold) return null;
  return SUPPLY_LOADS[entry.kind] ?? null;
}

/**
 * The trap this fixture needs, in metres.
 *
 * The catalogue's figure where it has one, the code's minimum otherwise, and
 * whichever is LARGER when both exist — a catalogue entry may specify a bigger
 * trap than the minimum, and it may never specify a smaller one.
 */
export function trapSizeOf(fixtureId: string): number {
  const entry = getFixture(fixtureId);
  const code = drainageLoadOf(fixtureId);
  const catalogue = entry?.connections.waste !== null && entry?.connections.waste !== undefined
    ? entry.connections.waste / 1000
    : 0;
  return Math.max(catalogue, code?.trapSize ?? 0);
}

/** Whether this fixture discharges soil, as distinct from waste. */
export function isSoilFixture(fixtureId: string): boolean {
  return getFixture(fixtureId)?.connections.soil === true;
}

/* --------------------------- Accumulating the load ------------------------ */

/**
 * The total load carried by every run, including everything upstream.
 *
 * One pass per run, walking its own fixtures downstream. The `guard` set makes
 * a cycle — which a hand-edited file could contain — terminate instead of
 * hanging the tab, and it is per-walk rather than global because two runs may
 * legitimately pass through the same downstream pipe.
 */
export function accumulateDfu(doc: DesignDocument): Map<string, Dfu> {
  const totals = new Map<string, number>();
  const byId = new Map(doc.plumbing.drainage.map((run) => [run.id, run]));
  for (const run of doc.plumbing.drainage) totals.set(run.id, 0);

  for (const run of doc.plumbing.drainage) {
    // A vent carries air, not water. Its size comes off the drain it serves.
    if (run.system === 'vent') continue;

    let own = 0;
    for (const fixtureId of run.serves) {
      const fixture = doc.fixtures.find((candidate) => candidate.id === fixtureId);
      if (!fixture) continue;
      own += drainageLoadOf(fixture.fixtureId)?.dfu ?? 0;
    }
    if (own === 0) continue;

    let current: PipeRun | undefined = run;
    const guard = new Set<string>();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      totals.set(current.id, (totals.get(current.id) ?? 0) + own);
      current = current.downstreamId ? byId.get(current.downstreamId) : undefined;
    }
  }

  return new Map([...totals].map(([id, value]) => [id, asDfu(value)]));
}

/** How many water closets each run carries, for the two-WC rule on a 3 in pipe. */
export function accumulateWaterClosets(doc: DesignDocument): Map<string, number> {
  const totals = new Map<string, number>();
  const byId = new Map(doc.plumbing.drainage.map((run) => [run.id, run]));
  for (const run of doc.plumbing.drainage) totals.set(run.id, 0);

  for (const run of doc.plumbing.drainage) {
    if (run.system === 'vent') continue;

    let own = 0;
    for (const fixtureId of run.serves) {
      const fixture = doc.fixtures.find((candidate) => candidate.id === fixtureId);
      if (fixture && isSoilFixture(fixture.fixtureId)) own += 1;
    }
    if (own === 0) continue;

    let current: PipeRun | undefined = run;
    const guard = new Set<string>();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      totals.set(current.id, (totals.get(current.id) ?? 0) + own);
      current = current.downstreamId ? byId.get(current.downstreamId) : undefined;
    }
  }

  return totals;
}

/**
 * The supply load on every run, hot and cold kept apart.
 *
 * A cold run carries its fixtures' cold column and a hot run their hot column,
 * because those are different numbers in Table E103.3(2) and adding them would
 * oversize every cold main in the building.
 */
export function accumulateWsfu(doc: DesignDocument): Map<string, Wsfu> {
  const totals = new Map<string, number>();
  const byId = new Map(doc.plumbing.supply.map((run) => [run.id, run]));
  for (const run of doc.plumbing.supply) totals.set(run.id, 0);

  for (const run of doc.plumbing.supply) {
    let own = 0;
    for (const fixtureId of run.serves) {
      const fixture = doc.fixtures.find((candidate) => candidate.id === fixtureId);
      if (!fixture) continue;
      const load = supplyLoadOf(fixture.fixtureId);
      if (!load) continue;
      own += run.system === 'cold' ? load.cold : load.hot;
    }
    if (own === 0) continue;

    let current: PipeRun | undefined = run;
    const guard = new Set<string>();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      totals.set(current.id, (totals.get(current.id) ?? 0) + own);
      // A hot return carries no draw-off of its own but must be big enough for
      // what circulates, so it inherits the tree it serves.
      current = current.downstreamId ? byId.get(current.downstreamId) : undefined;
    }
  }

  return new Map([...totals].map(([id, value]) => [id, asWsfu(value)]));
}

/* ------------------------------- Geometry --------------------------------- */

/** A pipe point's height in world terms, above the building's ground floor. */
export function worldHeight(doc: DesignDocument, point: PipePoint): number {
  return elevationOf(doc, point.levelId) + point.height;
}

/** How far a run travels in plan, in metres. Vertical drops contribute nothing. */
export function horizontalLength(run: PipeRun): number {
  let total = 0;
  for (let i = 1; i < run.points.length; i += 1) {
    const from = run.points[i - 1]!;
    const to = run.points[i]!;
    total += Math.hypot(to.at.x - from.at.x, to.at.z - from.at.z);
  }
  return total;
}

/** How far a run travels in total, including the vertical, in metres. */
export function developedLength(doc: DesignDocument, run: PipeRun): number {
  let total = 0;
  for (let i = 1; i < run.points.length; i += 1) {
    const from = run.points[i - 1]!;
    const to = run.points[i]!;
    const rise = worldHeight(doc, to) - worldHeight(doc, from);
    total += Math.hypot(Math.hypot(to.at.x - from.at.x, to.at.z - from.at.z), rise);
  }
  return total;
}

/**
 * How much a run falls per metre travelled horizontally, as a ratio.
 *
 * Null for a run with no horizontal travel at all: a vertical drop has no
 * slope, and reporting one as "infinitely steep" would put a meaningless
 * finding in front of the user on every stack in the building.
 *
 * Positive means it falls the right way — downhill from the upstream end.
 */
export function slopeOf(doc: DesignDocument, run: PipeRun): number | null {
  const horizontal = horizontalLength(run);
  if (horizontal < 1e-6) return null;

  const first = run.points[0];
  const last = run.points[run.points.length - 1];
  if (!first || !last) return null;

  return (worldHeight(doc, first) - worldHeight(doc, last)) / horizontal;
}

/* ------------------------------- The sizes -------------------------------- */

/**
 * How big a vent is, given the drain it serves.
 *
 * Two genuinely different cases, and conflating them was a real defect caught
 * by the tests:
 *
 *   • A STACK VENT is the soil stack CONTINUED above the highest branch. It is
 *     the same physical pipe, so it is the same size. Sizing it at half the
 *     stack — which is what IPC 916.2's minimum alone would give — models a
 *     reducer at roof level that nobody builds and no plumber would fit.
 *   • A REVENT is a separate pipe taken off a branch to protect one trap. That
 *     one really is sized by 916.2: half the drain it serves, never below
 *     1 1/4 in.
 *
 * Both satisfy 916.2, because a full-size stack vent is comfortably more than
 * half of itself. The distinction is about drawing what gets built.
 */
function ventSize(doc: DesignDocument, served: PipeRun, servedSize: DrainSize): DrainSize {
  const role = roleOf(doc, served);
  if (role === 'stack' || role === 'building-drain') return servedSize;
  return nearestDrainSize(ventSizeFor(servedSize.size));
}

/** What kind of drain a run is, which decides which of the three tables sizes it. */
export type DrainRole = 'branch' | 'stack' | 'building-drain' | 'vent';

/**
 * Which sizing table applies to a run.
 *
 * The building drain is the one that leaves the building, which is the run
 * nothing is downstream of. A stack is a run whose travel is mostly vertical.
 * Everything else is a horizontal branch.
 */
export function roleOf(doc: DesignDocument, run: PipeRun): DrainRole {
  if (run.system === 'vent') return 'vent';
  if (run.downstreamId === null) return 'building-drain';

  const horizontal = horizontalLength(run);
  const first = run.points[0];
  const last = run.points[run.points.length - 1];
  const rise =
    first && last ? Math.abs(worldHeight(doc, last) - worldHeight(doc, first)) : 0;

  return rise > horizontal ? 'stack' : 'branch';
}

/**
 * The diameter a drainage run must be.
 *
 * A trap arm can never be smaller than the trap it serves (IPC 909.1), so the
 * fixtures' own trap sizes set a floor under whatever the DFU table returns.
 * Without that a single basin's 1 DFU would size a 1¼ in branch off a 1½ in
 * trap, which is a reducer on a drain — the one fitting that guarantees a
 * blockage.
 */
export function sizeDrainageRun(doc: DesignDocument, run: PipeRun): DrainSize {
  const role = roleOf(doc, run);

  if (role === 'vent') {
    const served = run.downstreamId
      ? doc.plumbing.drainage.find((candidate) => candidate.id === run.downstreamId)
      : null;
    if (!served) return nearestDrainSize(ventSizeFor(0));

    const servedSize = sizeDrainageRun(doc, served);
    return ventSize(doc, served, servedSize);
  }

  const dfu = accumulateDfu(doc).get(run.id) ?? asDfu(0);
  const waterClosets = accumulateWaterClosets(doc).get(run.id) ?? 0;

  const table =
    role === 'building-drain'
      ? buildingDrainSizeFor(dfu, waterClosets)
      : role === 'stack'
        ? stackSizeFor(dfu, waterClosets)
        : branchSizeFor(dfu, waterClosets > 0);

  // Never smaller than the largest trap discharging into it.
  let floor = 0;
  for (const fixtureId of run.serves) {
    const fixture = doc.fixtures.find((candidate) => candidate.id === fixtureId);
    if (fixture) floor = Math.max(floor, trapSizeOf(fixture.fixtureId));
  }
  return table.size >= floor - 1e-9 ? table : nearestDrainSize(floor);
}

/**
 * The diameter a supply run must be, from its WSFU load.
 *
 * The service — the run nothing is downstream of — goes through
 * `serviceSizeFor`, which applies IPC 603.1's 3/4 in floor. A small house sizes
 * to 1/2 in on the fixture-unit table alone, and 1/2 in is not a legal service.
 */
export function sizeSupplyRun(doc: DesignDocument, run: PipeRun): SupplySize {
  const wsfu = accumulateWsfu(doc).get(run.id) ?? asWsfu(0);
  return run.downstreamId === null ? serviceSizeFor(wsfu) : supplySizeFor(wsfu);
}

/** The minimum fall this run must have, given the size it works out to. */
export function requiredSlope(doc: DesignDocument, run: PipeRun): number {
  return minSlopeFor(sizeDrainageRun(doc, run).size).minSlope;
}

/**
 * Every drainage run with its size and load worked out, in one pass.
 *
 * The accumulators walk the whole tree, so calling `sizeDrainageRun` in a loop
 * re-walks it once per run. For a schedule or a check that wants all of them
 * this does the walk twice in total instead of twice per run.
 */
export interface SizedRun {
  run: PipeRun;
  role: DrainRole;
  dfu: Dfu;
  waterClosets: number;
  size: DrainSize;
  slope: number | null;
  requiredSlope: number;
  horizontalLength: number;
}

export function sizeAllDrainage(doc: DesignDocument): SizedRun[] {
  const dfuByRun = accumulateDfu(doc);
  const wcByRun = accumulateWaterClosets(doc);
  const sizes = new Map<string, DrainSize>();

  // Drains before vents, because a vent's size is read off the drain it serves.
  const ordered = [...doc.plumbing.drainage].sort(
    (a, b) => (a.system === 'vent' ? 1 : 0) - (b.system === 'vent' ? 1 : 0),
  );

  const results: SizedRun[] = [];
  for (const run of ordered) {
    const role = roleOf(doc, run);
    const dfu = dfuByRun.get(run.id) ?? asDfu(0);
    const waterClosets = wcByRun.get(run.id) ?? 0;

    let size: DrainSize;
    if (role === 'vent') {
      const served = run.downstreamId
        ? doc.plumbing.drainage.find((candidate) => candidate.id === run.downstreamId)
        : undefined;
      const servedSize = run.downstreamId ? sizes.get(run.downstreamId) : undefined;
      size =
        served && servedSize
          ? ventSize(doc, served, servedSize)
          : nearestDrainSize(ventSizeFor(0));
    } else {
      const table =
        role === 'building-drain'
          ? buildingDrainSizeFor(dfu, waterClosets)
          : role === 'stack'
            ? stackSizeFor(dfu, waterClosets)
            : branchSizeFor(dfu, waterClosets > 0);

      let floor = 0;
      for (const fixtureId of run.serves) {
        const fixture = doc.fixtures.find((candidate) => candidate.id === fixtureId);
        if (fixture) floor = Math.max(floor, trapSizeOf(fixture.fixtureId));
      }
      size = table.size >= floor - 1e-9 ? table : nearestDrainSize(floor);
    }

    sizes.set(run.id, size);
    results.push({
      run,
      role,
      dfu,
      waterClosets,
      size,
      slope: slopeOf(doc, run),
      requiredSlope: minSlopeFor(size.size).minSlope,
      horizontalLength: horizontalLength(run),
    });
  }

  // Back into the document's own order, so schedules read the way the plan does.
  const order = new Map(doc.plumbing.drainage.map((run, index) => [run.id, index]));
  return results.sort((a, b) => (order.get(a.run.id) ?? 0) - (order.get(b.run.id) ?? 0));
}

/** Every supply run with its size and load. */
export interface SizedSupplyRun {
  run: PipeRun;
  wsfu: Wsfu;
  size: SupplySize;
  developedLength: number;
}

export function sizeAllSupply(doc: DesignDocument): SizedSupplyRun[] {
  const wsfuByRun = accumulateWsfu(doc);
  return doc.plumbing.supply.map((run) => {
    const wsfu = wsfuByRun.get(run.id) ?? asWsfu(0);
    return {
      run,
      wsfu,
      // The service carries 603.1's floor; everything downstream of it does not.
      size: run.downstreamId === null ? serviceSizeFor(wsfu) : supplySizeFor(wsfu),
      developedLength: developedLength(doc, run),
    };
  });
}

/* --------------------------- Whole-building totals ------------------------ */

export interface PlumbingTotals {
  /** Every fixture that drains, and what they add up to. */
  drainageFixtures: number;
  totalDfu: Dfu;
  waterClosets: number;
  /** Every fixture that draws water. */
  supplyFixtures: number;
  coldWsfu: Wsfu;
  hotWsfu: Wsfu;
  totalWsfu: Wsfu;
}

/**
 * What the whole building loads its services with.
 *
 * Counted from the FIXTURES rather than from the routed pipe, deliberately.
 * These totals are what the building drain and the water service have to be
 * sized for, and a fixture nobody has run a pipe to still has to appear in
 * them — otherwise forgetting to route a bathroom would make the service look
 * comfortably sized.
 */
export function plumbingTotals(doc: DesignDocument): PlumbingTotals {
  let drainageFixtures = 0;
  let totalDfu = 0;
  let waterClosets = 0;
  let supplyFixtures = 0;
  let coldWsfu = 0;
  let hotWsfu = 0;
  let totalWsfu = 0;

  for (const fixture of doc.fixtures) {
    const drainage = drainageLoadOf(fixture.fixtureId);
    if (drainage) {
      drainageFixtures += 1;
      totalDfu += drainage.dfu;
      if (drainage.soil) waterClosets += 1;
    }

    const supply = supplyLoadOf(fixture.fixtureId);
    if (supply) {
      supplyFixtures += 1;
      coldWsfu += supply.cold;
      hotWsfu += supply.hot;
      totalWsfu += supply.total;
    }
  }

  return {
    drainageFixtures,
    totalDfu: asDfu(totalDfu),
    waterClosets,
    supplyFixtures,
    coldWsfu: asWsfu(coldWsfu),
    hotWsfu: asWsfu(hotWsfu),
    totalWsfu: asWsfu(totalWsfu),
  };
}
