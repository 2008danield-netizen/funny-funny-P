/**
 * Editing the cabinetry and the fixtures.
 *
 * The same contract every other ops module here follows: each function takes a
 * draft and mutates it in place, and `designStore.edit` runs the recipe exactly
 * once so an undo step is one intention rather than one keystroke.
 *
 * -----------------------------------------------------------------------------
 * THE ONE RULE WORTH STATING.
 *
 * Re-filling a run THROWS AWAY the units in it and works them out again. That
 * is destructive, and it is deliberate: a run whose path has changed is a
 * different length, and quietly keeping the old units would leave a kitchen
 * that overhangs the wall or stops short of it. So `refillRun` is only called
 * where the user asked for it — redrawing the path, or pressing the button that
 * says so — and never as a side effect of anything else.
 *
 * Fixtures survive it. A sink built into a unit that no longer exists becomes
 * free-standing and stays where it was put, which is visible and correctable;
 * deleting it would lose something somebody chose and paid for.
 */

import { fillRun, runGeometry, runSegments, type FillOptions } from '@/building/cabinetRun';
import { CARCASS, getModule, worktopMaterial } from '@/fittings/modules';
import { getFixture } from '@/fittings/fixtures';
import { defaultWorktop } from './defaults';
import { levelById } from './levels';
import { nearestWall } from './planOps';
import { indexVertices, resolveWall } from '@/scene/planGraph';
import { rotationFacing } from '@/advisor/geometry';
import { FITTING_LIMITS } from './types';
import type {
  CabinetKind,
  CabinetRun,
  DesignDocument,
  Fixture,
  PlanModel,
  Point2,
  WorktopMaterial,
} from './types';

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Starts the numbering again, so a layout is reproducible in a test. */
export function resetFittingIds(): void {
  counter = 0;
}

/* ---------------------------------- Runs ---------------------------------- */

/**
 * Adds a run along a path, filled.
 *
 * The path is taken as given — the tool that produced it is responsible for
 * having it against a wall and oriented so its units face into the room. That
 * split keeps this function usable by the auto-layout, which knows exactly
 * where its walls are, and by the pointer tool, which has to work it out.
 */
export function addRun(
  doc: DesignDocument,
  levelId: string,
  path: readonly Point2[],
  kind: CabinetKind,
  options: FillOptions = {},
): string | null {
  if (path.length < 2 || !levelById(doc, levelId)) return null;

  const run: CabinetRun = {
    id: nextId('run'),
    levelId,
    path: path.map((point) => ({ x: point.x, z: point.z })),
    kind,
    units: fillRun(path, kind, options),
    worktop: kind === 'base' ? defaultWorktop() : null,
    finishId: 'white',
  };

  if (run.units.length === 0) return null;
  doc.runs.push(run);
  return run.id;
}

/** Works the units out again for a run whose path or purpose has changed. */
export function refillRun(doc: DesignDocument, runId: string, options: FillOptions = {}): void {
  const run = doc.runs.find((entry) => entry.id === runId);
  if (!run) return;

  const before = new Set(run.units.map((unit) => unit.id));
  run.units = fillRun(run.path, run.kind, options);

  // Anything that was built into a unit that has just ceased to exist becomes
  // free-standing rather than vanishing with it.
  for (const fixture of doc.fixtures) {
    if (fixture.hostUnitId && before.has(fixture.hostUnitId)) fixture.hostUnitId = null;
  }
}

export function updateRun(doc: DesignDocument, runId: string, changes: Partial<CabinetRun>): void {
  const run = doc.runs.find((entry) => entry.id === runId);
  if (!run) return;

  Object.assign(run, changes);
  // A worktop on a wall run is a field that will eventually be read.
  if (run.kind !== 'base') run.worktop = null;
  else if (!run.worktop) run.worktop = defaultWorktop();
}

export function setWorktopMaterial(
  doc: DesignDocument,
  runId: string,
  material: WorktopMaterial,
): void {
  const run = doc.runs.find((entry) => entry.id === runId);
  if (!run?.worktop) return;
  run.worktop.material = material;
  run.worktop.colour = worktopMaterial(material).colour;
}

/** Swaps one unit for a different module of the same width. */
export function setUnitModule(
  doc: DesignDocument,
  runId: string,
  unitId: string,
  moduleId: string,
): void {
  const run = doc.runs.find((entry) => entry.id === runId);
  const unit = run?.units.find((entry) => entry.id === unitId);
  const module = getModule(moduleId);
  if (!run || !unit || !module) return;

  /*
   * The width does not change. Swapping a 600 door base for a 600 drawer base
   * is a choice; swapping it for an 800 would move every unit after it along
   * and push the last one through the wall, so it is simply not offered.
   */
  if (Math.abs(module.width - unit.width) > 1e-6) return;
  unit.moduleId = moduleId;
}

export function removeRun(doc: DesignDocument, runId: string): void {
  const run = doc.runs.find((entry) => entry.id === runId);
  if (!run) return;

  const ids = new Set(run.units.map((unit) => unit.id));
  doc.runs = doc.runs.filter((entry) => entry.id !== runId);
  for (const fixture of doc.fixtures) {
    if (fixture.hostUnitId && ids.has(fixture.hostUnitId)) fixture.hostUnitId = null;
  }
}

/**
 * Turns two points dragged across the floor into a run along a wall.
 *
 * -----------------------------------------------------------------------------
 * WHY THE DRAG IS NOT THE PATH.
 *
 * Nobody drags accurately along a wall. The gesture means "cabinets along this
 * wall, roughly from here to here", and taking it literally produces a run
 * 40 mm off the wall with a gap behind it — which is not a kitchen, it is a
 * drawing of one.
 *
 * So the wall is found, the two ends are projected onto its interior FACE, and
 * the path is ordered so its anticlockwise normal points into the room. That
 * last part is the convention every piece of run geometry depends on: get it
 * backwards and the whole kitchen faces the wall.
 *
 * Returns null when the drag was not along a wall, or was too short to hold
 * anything — which the caller reports rather than silently placing something
 * somewhere else.
 */
export function snapRunToWall(
  plan: PlanModel,
  from: Point2,
  to: Point2,
): Point2[] | null {
  const middle = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
  const near = nearestWall(plan, middle, FITTING_LIMITS.maxWallGap + 1.2);
  if (!near) return null;

  const segment = resolveWall(near.wall, indexVertices(plan));
  if (!segment) return null;

  // Which face of the wall the drag was on decides which way the run faces.
  const toDrag = { x: middle.x - segment.center.x, z: middle.z - segment.center.z };
  const side = toDrag.x * segment.normal.x + toDrag.z * segment.normal.z >= 0 ? 1 : -1;
  const inward = { x: segment.normal.x * side, z: segment.normal.z * side };
  const faceOffset = near.wall.thickness / 2;

  /** Where a point falls along the wall, clamped to it. */
  const project = (point: Point2) => {
    const along =
      (point.x - segment.start.x) * segment.direction.x +
      (point.z - segment.start.z) * segment.direction.z;
    return Math.max(0, Math.min(segment.length, along));
  };

  const a = project(from);
  const b = project(to);
  if (Math.abs(b - a) < FITTING_LIMITS.minRunLength) return null;

  const onFace = (along: number): Point2 => ({
    x: segment.start.x + segment.direction.x * along + inward.x * faceOffset,
    z: segment.start.z + segment.direction.z * along + inward.z * faceOffset,
  });

  const path = [onFace(Math.min(a, b)), onFace(Math.max(a, b))];

  // Order the two ends so the path's own anticlockwise normal is `inward`.
  const direction = { x: path[1]!.x - path[0]!.x, z: path[1]!.z - path[0]!.z };
  const normal = { x: -direction.z, z: direction.x };
  return normal.x * inward.x + normal.z * inward.z > 0 ? path : [path[1]!, path[0]!];
}

/* -------------------------------- Fixtures -------------------------------- */

/**
 * Adds a fixture, seated against the nearest wall if it wants one.
 *
 * A WC, a basin and a bath all stand against something, and dropping one in the
 * middle of the floor facing an arbitrary direction makes the user do work the
 * app can do. A shower goes in a corner, and finds one.
 */
export function addFixture(
  doc: DesignDocument,
  levelId: string,
  fixtureId: string,
  at: Point2,
): string | null {
  const level = levelById(doc, levelId);
  const entry = getFixture(fixtureId);
  if (!level || !entry) return null;

  const fixture: Fixture = {
    id: nextId('fx'),
    levelId,
    fixtureId,
    at: { x: at.x, z: at.z },
    rotation: 0,
    y: 0,
    hostUnitId: null,
  };

  if (entry.placement !== 'free') seatAgainstWall(doc, fixture);
  doc.fixtures.push(fixture);
  return fixture.id;
}

/**
 * Puts a fixture flat against the nearest wall, facing into the room.
 *
 * Returns false when there is no wall near enough to seat against, in which
 * case the fixture is left where it is — floating a bath a metre off the wall
 * because the nearest one was five metres away would be worse than leaving it.
 */
export function seatAgainstWall(doc: DesignDocument, fixture: Fixture, reach = 1.5): boolean {
  const level = levelById(doc, fixture.levelId);
  const entry = getFixture(fixture.fixtureId);
  if (!level || !entry) return false;

  const near = nearestWall(level.plan, fixture.at, reach);
  if (!near) return false;

  const segment = resolveWall(near.wall, indexVertices(level.plan));
  if (!segment) return false;

  // Which face it is on decides which way it turns, so dragging a WC round a
  // corner works rather than leaving it facing the wall.
  const toFixture = { x: fixture.at.x - segment.center.x, z: fixture.at.z - segment.center.z };
  const side =
    toFixture.x * segment.normal.x + toFixture.z * segment.normal.z >= 0 ? 1 : -1;
  const inward = { x: segment.normal.x * side, z: segment.normal.z * side };

  const along = Math.max(
    entry.width / 2,
    Math.min(segment.length - entry.width / 2, near.t * segment.length),
  );
  const standoff = near.wall.thickness / 2 + entry.depth / 2;

  fixture.at = {
    x: segment.start.x + segment.direction.x * along + inward.x * standoff,
    z: segment.start.z + segment.direction.z * along + inward.z * standoff,
  };
  fixture.rotation = rotationFacing(inward);
  return true;
}

export function moveFixture(doc: DesignDocument, id: string, at: Point2, seat = true): void {
  const fixture = doc.fixtures.find((entry) => entry.id === id);
  if (!fixture) return;

  fixture.at = { x: at.x, z: at.z };
  const entry = getFixture(fixture.fixtureId);
  if (seat && entry && entry.placement !== 'free') {
    fixture.hostUnitId = null;
    seatAgainstWall(doc, fixture);
  }
}

export function rotateFixture(doc: DesignDocument, id: string, radians: number): void {
  const fixture = doc.fixtures.find((entry) => entry.id === id);
  if (fixture) fixture.rotation = radians;
}

export function removeFixture(doc: DesignDocument, id: string): void {
  doc.fixtures = doc.fixtures.filter((entry) => entry.id !== id);
}

/**
 * Drops a fixture into the unit built to take it, and puts it there.
 *
 * A sink sits in the middle of its sink base, at the top of the carcass; a hob
 * likewise; a dishwasher fills its gap. Doing it here rather than leaving the
 * user to line it up by eye is the difference between a plan and a drawing of
 * one — and it is what lets the electrical say "this dishwasher is in the
 * kitchen run, on that circuit" without guessing.
 */
export function hostFixture(doc: DesignDocument, fixtureId: string, unitId: string): boolean {
  const fixture = doc.fixtures.find((entry) => entry.id === fixtureId);
  const entry = fixture ? getFixture(fixture.fixtureId) : null;
  if (!fixture || !entry) return false;

  const run = doc.runs.find((candidate) => candidate.units.some((unit) => unit.id === unitId));
  if (!run) return false;

  const placed = runGeometry(run).units.find((unit) => unit.unit.id === unitId);
  if (!placed) return false;

  const module = getModule(placed.unit.moduleId);
  if (!module || !module.hosts.some((kind) => kind === entry.kind)) return false;

  fixture.hostUnitId = unitId;
  fixture.at = { x: placed.at.x, z: placed.at.z };
  fixture.rotation = placed.rotation;
  // A sink or a hob sits in the worktop; anything else stands on the floor
  // inside the carcass.
  fixture.y =
    entry.kind === 'sink' || entry.kind === 'hob'
      ? CARCASS[run.kind].lift + CARCASS[run.kind].height
      : CARCASS[run.kind].lift;
  return true;
}

/* -------------------------------- Queries --------------------------------- */

/** Every run on one storey. */
export function runsOn(doc: DesignDocument, levelId: string): CabinetRun[] {
  return doc.runs.filter((run) => run.levelId === levelId);
}

/** Every fixture on one storey. */
export function fixturesOn(doc: DesignDocument, levelId: string): Fixture[] {
  return doc.fixtures.filter((fixture) => fixture.levelId === levelId);
}

/** Clears the cabinetry and the fixtures from one room's worth of the plan. */
export function clearFittingsIn(doc: DesignDocument, levelId: string, polygon: readonly Point2[]): void {
  const inside = (point: Point2) => pointInPolygon(point, polygon);

  const doomed = new Set<string>();
  for (const run of doc.runs) {
    if (run.levelId !== levelId) continue;
    // A run counts as in the room when its middle is: a run along the room's
    // own wall has its path ON the boundary, where a point test is a coin toss.
    const segments = runSegments(run.path);
    const middle = segments[Math.floor(segments.length / 2)];
    if (!middle) continue;
    const at = {
      x: (middle.from.x + middle.to.x) / 2 + middle.normal.x * 0.1,
      z: (middle.from.z + middle.to.z) / 2 + middle.normal.z * 0.1,
    };
    if (inside(at)) {
      doomed.add(run.id);
      for (const unit of run.units) doomed.add(unit.id);
    }
  }

  doc.runs = doc.runs.filter((run) => !doomed.has(run.id));
  doc.fixtures = doc.fixtures.filter(
    (fixture) => fixture.levelId !== levelId || !inside(fixture.at),
  );
}

/** Point-in-polygon, by the ray-crossing rule the rest of the app uses. */
function pointInPolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.z > point.z === b.z > point.z) continue;
    const crossing = ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
    if (point.x < crossing) inside = !inside;
  }
  return inside;
}
