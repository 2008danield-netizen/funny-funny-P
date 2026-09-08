/**
 * Editing the plumbing.
 *
 * Every function here mutates a draft document inside `designStore.edit`, the
 * same contract as `fittingOps` and `planOps`: take a draft, change it, return
 * nothing. Undo is the store's problem, not this file's.
 *
 * -----------------------------------------------------------------------------
 * THE ONE RULE THAT SHAPES ALL OF IT: A HAND-EDITED PIPE IS SACRED.
 *
 * The whole point of being able to move a pipe is that the app then leaves it
 * alone. So every edit that touches a run's geometry sets `manual`, and both
 * routers skip anything marked that way. An app that helpfully re-routes over
 * somebody's correction is an app they stop correcting.
 */

import { routeDrainage, resetPlumbingIds, type RouteResult } from '@/services/drainage';
import { routeSupply, resetSupplyIds, placeHeater } from '@/services/supply';
import { PLUMBING_LIMITS, type DesignDocument, type PipeRun, type Point2 } from './types';

/* ------------------------------- Routing ---------------------------------- */

/**
 * Routes drainage and supply in one pass, and merges what each reported.
 *
 * Drainage first, deliberately: the supply router reads the connection records
 * drainage writes, so running them the other way round would leave every
 * fixture's trap details empty until the next pass.
 */
export function routeAll(doc: DesignDocument): RouteResult {
  const drainage = routeDrainage(doc);
  const supply = routeSupply(doc);

  const assumptions: string[] = [];
  for (const note of [...drainage.assumptions, ...supply.assumptions]) {
    if (!assumptions.includes(note)) assumptions.push(note);
  }

  return {
    stacks: drainage.stacks,
    // Drainage branches only. Supply runs are counted separately, because
    // adding them together reports the same pipes under two headings.
    branches: drainage.branches,
    vents: drainage.vents,
    supplyRuns: supply.supplyRuns,
    connected: Math.max(drainage.connected, supply.connected),
    assumptions,
  };
}

/** Throws the whole installation away. */
export function clearPlumbing(doc: DesignDocument): void {
  doc.plumbing.drainage = [];
  doc.plumbing.supply = [];
  doc.plumbing.stacks = [];
  doc.plumbing.connections = [];
  doc.plumbing.heater = null;
}

/** Restarts the id counters, so a test gets the same ids from the same input. */
export function resetPlumbingCounters(): void {
  resetPlumbingIds();
  resetSupplyIds();
}

/* ------------------------------- The site --------------------------------- */

/**
 * Where the drainage leaves the plot, and how deep.
 *
 * The depth is the number that matters and the one nobody has to hand, so it
 * is clamped rather than trusted: a sewer 40 m down would silently make every
 * fall check pass.
 */
export function setSewerConnection(
  doc: DesignDocument,
  at: Point2,
  invertDepth: number,
): void {
  doc.site.sewerConnection = {
    at,
    invertDepth: Math.min(
      PLUMBING_LIMITS.maxInvertDepth,
      Math.max(PLUMBING_LIMITS.minInvertDepth, invertDepth),
    ),
  };
}

/** Where the water service enters the plot. */
export function setWaterService(doc: DesignDocument, at: Point2): void {
  doc.site.waterService = { at };
}

/**
 * The street pressure, and whether somebody measured it.
 *
 * The flag is not decoration. The supply calculation is more sensitive to this
 * one figure than to anything else in the model, and a check that cannot tell a
 * measurement from a default cannot tell the user which of its findings to
 * trust.
 */
export function setMainPressure(doc: DesignDocument, kpa: number, measured: boolean): void {
  doc.plumbing.mainPressureKpa = Math.min(
    PLUMBING_LIMITS.maxMainPressureKpa,
    Math.max(PLUMBING_LIMITS.minMainPressureKpa, kpa),
  );
  doc.plumbing.mainPressureMeasured = measured;
}

/* ------------------------------- The heater ------------------------------- */

export function setHeaterKind(doc: DesignDocument, kind: 'storage' | 'instantaneous'): void {
  const heater = doc.plumbing.heater ?? placeHeater(doc);
  if (!heater) return;
  doc.plumbing.heater = {
    ...heater,
    kind,
    // An instantaneous heater stores nothing. Keeping a volume on one would put
    // a cylinder size on the schedule for a unit that has no cylinder.
    litres: kind === 'instantaneous' ? 0 : heater.litres || 150,
  };
}

export function setHeaterLitres(doc: DesignDocument, litres: number): void {
  if (!doc.plumbing.heater || doc.plumbing.heater.kind !== 'storage') return;
  doc.plumbing.heater = {
    ...doc.plumbing.heater,
    litres: Math.min(1000, Math.max(0, litres)),
  };
}

export function setRecirculation(doc: DesignDocument, on: boolean): void {
  if (!doc.plumbing.heater) return;
  doc.plumbing.heater = { ...doc.plumbing.heater, recirculation: on };
}

export function moveHeater(doc: DesignDocument, at: Point2): void {
  if (!doc.plumbing.heater) return;
  doc.plumbing.heater = { ...doc.plumbing.heater, at };
}

/* -------------------------------- The stack ------------------------------- */

/**
 * Moves the stack, and everything hanging off it.
 *
 * A stack that moved without its branches would leave every pipe in the
 * building pointing at where it used to be — so the branches follow, keeping
 * their own shape but landing on the new position. Their falls are then
 * whatever the new geometry gives, and the checker says so if that is not
 * enough; recomputing the falls here would quietly hide a move that does not
 * work.
 */
export function moveStack(doc: DesignDocument, stackId: string, at: Point2): void {
  const stack = doc.plumbing.stacks.find((candidate) => candidate.id === stackId);
  if (!stack) return;

  const from = stack.at;
  stack.at = at;

  for (const run of doc.plumbing.drainage) {
    run.points = run.points.map((point) =>
      Math.hypot(point.at.x - from.x, point.at.z - from.z) < 1e-6
        ? { ...point, at: { ...at } }
        : point,
    );
  }
}

export function setVentHeight(doc: DesignDocument, stackId: string, above: number): void {
  const stack = doc.plumbing.stacks.find((candidate) => candidate.id === stackId);
  if (!stack) return;
  stack.ventAboveRoof = Math.min(3, Math.max(0.1, above));
}

/* --------------------------------- Runs ----------------------------------- */

/** Finds a run in either system. */
export function findRun(doc: DesignDocument, runId: string): PipeRun | null {
  return (
    doc.plumbing.drainage.find((run) => run.id === runId) ??
    doc.plumbing.supply.find((run) => run.id === runId) ??
    null
  );
}

/**
 * Moves one vertex of a run, and marks the run hand-edited.
 *
 * Marking it is the whole point: from here on the routers leave this pipe
 * alone, which is what makes a correction stick.
 */
export function movePipePoint(
  doc: DesignDocument,
  runId: string,
  index: number,
  at: Point2,
  height?: number,
): void {
  const run = findRun(doc, runId);
  const point = run?.points[index];
  if (!run || !point) return;

  run.points[index] = { ...point, at, height: height ?? point.height };
  run.manual = true;
}

/** Hands a run back to the router, so the next pass re-draws it. */
export function releaseRun(doc: DesignDocument, runId: string): void {
  const run = findRun(doc, runId);
  if (run) run.manual = false;
}

/** Deletes a run, and detaches anything that pointed at it. */
export function removeRun(doc: DesignDocument, runId: string): void {
  doc.plumbing.drainage = doc.plumbing.drainage.filter((run) => run.id !== runId);
  doc.plumbing.supply = doc.plumbing.supply.filter((run) => run.id !== runId);

  for (const run of [...doc.plumbing.drainage, ...doc.plumbing.supply]) {
    if (run.downstreamId === runId) run.downstreamId = null;
  }
  for (const connection of doc.plumbing.connections) {
    if (connection.drainRunId === runId) connection.drainRunId = null;
    if (connection.ventRunId === runId) connection.ventRunId = null;
    if (connection.coldRunId === runId) connection.coldRunId = null;
    if (connection.hotRunId === runId) connection.hotRunId = null;
  }
}
