/**
 * Editing the building itself: storeys and staircases.
 *
 * The counterpart to `planOps` (which edits the walls on one storey) and
 * `furnitureOps` (which edits what stands on it). Everything here mutates a
 * draft inside `designStore.edit`, so a whole operation — adding a floor and
 * copying the walls up onto it — lands as one undo step.
 */

import { getOpeningPreset } from '@/scene/openings/presets';
import { defaultStairFor, stairGeometry } from '@/building/stairs';
import { footprintsOf } from '@/building/footprint';
import { roofGeometry } from '@/building/roof';
import { defaultRoofFor } from './defaults';
import {
  activeLevel,
  defaultLevelName,
  levelAbove,
  levelBelow,
  levelIndex,
  riseAbove,
} from './levels';
import { normalizePlan } from './planOps';
import {
  DORMER_LIMITS,
  LEVEL_LIMITS,
  type DesignDocument,
  type Dormer,
  type Level,
  type Point2,
  type Roof,
  type Skylight,
} from './types';

/* --------------------------------- Levels --------------------------------- */

function nextId(existing: readonly { id: string }[], prefix: string): string {
  let index = existing.length + 1;
  const taken = new Set(existing.map((entry) => entry.id));
  while (taken.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

/** An empty plan, for a storey that has nothing drawn on it yet. */
function emptyPlan(from: Level) {
  return {
    vertices: [],
    walls: [],
    rooms: {},
    // Carry the appearance down from the storey below, so a house does not
    // change decor halfway up by accident.
    defaultRoom: structuredClone(from.plan.defaultRoom),
    defaultWallHeight: from.plan.defaultWallHeight,
    defaultWallThickness: from.plan.defaultWallThickness,
  };
}

export interface AddLevelResult {
  id: string | null;
  reason?: string;
}

/**
 * Adds a storey above the top one, and makes it active.
 *
 * `copyWalls` traces the storey below. In practice this is what you want almost
 * every time — the external walls of a house run all the way up, and starting
 * from a blank floor means redrawing them by hand and getting them slightly
 * wrong. Internal walls come up too and are quicker to delete than to draw.
 */
export function addLevel(
  doc: DesignDocument,
  options: { copyWalls?: boolean } = {},
): AddLevelResult {
  if (doc.levels.length >= LEVEL_LIMITS.maxLevels) {
    return { id: null, reason: `A building here tops out at ${LEVEL_LIMITS.maxLevels} storeys` };
  }

  const below = doc.levels[doc.levels.length - 1]!;
  const id = nextId(doc.levels, 'lv');

  const level: Level = {
    id,
    name: defaultLevelName(doc.levels.length),
    wallHeight: below.wallHeight,
    slabThickness: below.slabThickness,
    plan: emptyPlan(below),
    furniture: [],
    voids: [],
  };

  if (options.copyWalls !== false) {
    copyWallsInto(level, below);
  }

  doc.levels.push(level);
  doc.activeLevelId = id;
  return { id };
}

/**
 * Traces one storey's walls onto another.
 *
 * Openings come with them, because a window that lines up vertically is the
 * normal case and a facade with staggered windows is the exception. Furniture
 * does not: nobody wants a second copy of their sofa one floor up.
 */
export function copyWallsInto(target: Level, source: Level): void {
  target.plan.vertices = structuredClone(source.plan.vertices);
  target.plan.walls = structuredClone(source.plan.walls);
  // Room appearance is keyed by which walls enclose a space, and the wall IDs
  // have been copied verbatim, so the rooms come across looking the same.
  target.plan.rooms = structuredClone(source.plan.rooms);
  normalizePlan(target.plan);
}

/**
 * Removes a storey.
 *
 * Refuses to remove the last one: a building with no levels has nowhere to
 * draw, and an editor that can get into that state has a blank screen with no
 * way back out. Any staircase standing on the removed level goes with it, since
 * it no longer has a floor to stand on.
 */
export function removeLevel(doc: DesignDocument, id: string): boolean {
  if (doc.levels.length <= 1) return false;
  const index = levelIndex(doc, id);
  if (index === -1) return false;

  doc.levels.splice(index, 1);
  doc.stairs = doc.stairs.filter((stair) => stair.fromLevelId !== id);

  if (doc.activeLevelId === id) {
    doc.activeLevelId = doc.levels[Math.min(index, doc.levels.length - 1)]!.id;
  }
  return true;
}

export function renameLevel(doc: DesignDocument, id: string, name: string): void {
  const level = doc.levels.find((entry) => entry.id === id);
  if (level) level.name = name.slice(0, 60);
}

export function setActiveLevel(doc: DesignDocument, id: string): void {
  if (doc.levels.some((level) => level.id === id)) doc.activeLevelId = id;
}

/* --------------------------------- Stairs --------------------------------- */

export interface AddStairResult {
  id: string | null;
  reason?: string;
}

/**
 * Puts the foot of a staircase at a point on the active storey.
 *
 * The proportions are derived rather than defaulted: the storey rise is divided
 * into steps as close to 7 in as a whole number allows, which is the middle of
 * the comfortable range rather than the edge of the legal one. A stair that
 * arrives compliant is a stair nobody has to be told about.
 */
export function addStair(doc: DesignDocument, at: Point2): AddStairResult {
  const level = activeLevel(doc);

  if (!levelAbove(doc, level.id)) {
    return { id: null, reason: 'Add a storey above before putting a stair in' };
  }

  const rise = riseAbove(doc, level.id);
  const defaults = defaultStairFor(rise);
  const id = nextId(doc.stairs, 'st');

  doc.stairs.push({
    id,
    name: `Stair ${doc.stairs.length + 1}`,
    fromLevelId: level.id,
    form: { kind: 'straight' },
    at: { x: at.x, z: at.z },
    rotation: 0,
    width: defaults.width,
    treadDepth: defaults.treadDepth,
    riserCount: defaults.riserCount,
    nosing: defaults.nosing,
    handrail: 'both',
  });

  return { id };
}

export function removeStair(doc: DesignDocument, id: string): void {
  doc.stairs = doc.stairs.filter((stair) => stair.id !== id);
}

/**
 * Changes a staircase, keeping the parts that must stay consistent.
 *
 * Riser count is clamped to what the storey rise can actually be divided into
 * legally — the app will let you build a stair the code rejects, and say so,
 * but it will not let you build one with zero or negative steps.
 */
export function updateStair(
  doc: DesignDocument,
  id: string,
  patch: Partial<Omit<DesignDocument['stairs'][number], 'id' | 'fromLevelId'>>,
): void {
  const stair = doc.stairs.find((candidate) => candidate.id === id);
  if (!stair) return;
  Object.assign(stair, patch);
  stair.riserCount = Math.max(2, Math.round(stair.riserCount));
}

/**
 * How much floor the stairwell takes out of the storey above.
 *
 * Reported in the inspector because it is the number that surprises people:
 * a comfortable staircase eats three or four square metres of the floor it
 * arrives on, and that is a room-planning fact rather than a stair fact.
 */
export function wellArea(doc: DesignDocument, stairId: string): number {
  const stair = doc.stairs.find((candidate) => candidate.id === stairId);
  if (!stair) return 0;
  const polygon = stairGeometry(doc, stair).wellOpening;
  if (polygon.length < 3) return 0;

  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += (polygon[j]!.x + polygon[i]!.x) * (polygon[j]!.z - polygon[i]!.z);
  }
  return Math.abs(area / 2);
}

/* ------------------------------ Convenience ------------------------------- */

/** The storey below the active one, for the ghost underlay. */
export function ghostPlan(doc: DesignDocument) {
  return levelBelow(doc, doc.activeLevelId)?.plan ?? null;
}

/** Re-exported so the stair tool can size a door opening consistently. */
export { getOpeningPreset };

/* ---------------------------------- Roofs --------------------------------- */

/**
 * Puts a roof over a storey.
 *
 * Over the TOP storey by default, because that is where a roof goes; putting
 * one over a middle floor is legal and occasionally right — a single-storey
 * wing off a two-storey house — but it is never what somebody means by "add a
 * roof" without saying more.
 *
 * Refuses a second roof over the same storey unless the first one is anchored
 * to a different structure, since two roofs over one building is not a design,
 * it is two roofs in the same place.
 */
export function addRoof(doc: DesignDocument, levelId?: string): string | null {
  const level = levelId ? doc.levels.find((entry) => entry.id === levelId) : doc.levels.at(-1);
  if (!level) return null;

  const existing = doc.roofs.filter((roof) => roof.overLevelId === level.id);
  const structures = footprintsOf(level);
  if (structures.length === 0) return null;
  if (existing.length >= structures.length) return null;

  // Anchor it to the first structure that has not got a roof yet.
  const taken = new Set(existing.map((roof) => roof.anchorWallId));
  const free = structures.find((footprint) => !footprint.wallIds.flat().some((id) => taken.has(id)));

  const id = nextId(doc.roofs, 'roof');
  doc.roofs.push({
    ...defaultRoofFor(level.id, id),
    // The first roof on a plan takes the largest structure implicitly, so it
    // does not need naming — and is then not disturbed by a wall being added.
    anchorWallId: existing.length === 0 ? null : (free?.wallIds[0]?.[0] ?? null),
  });
  return id;
}

export function removeRoof(doc: DesignDocument, id: string): void {
  doc.roofs = doc.roofs.filter((roof) => roof.id !== id);
}

export function updateRoof(doc: DesignDocument, id: string, changes: Partial<Roof>): void {
  const roof = doc.roofs.find((entry) => entry.id === id);
  if (!roof) return;
  Object.assign(roof, changes);
}

/** Turns one eave's gable on or off, by the wall that carries it. */
export function toggleGable(doc: DesignDocument, roofId: string, wallId: string): void {
  const roof = doc.roofs.find((entry) => entry.id === roofId);
  if (!roof) return;

  roof.gableWallIds = roof.gableWallIds.includes(wallId)
    ? roof.gableWallIds.filter((id) => id !== wallId)
    : [...roof.gableWallIds, wallId];
}

/**
 * Adds a dormer, placed where there is room for one.
 *
 * Low on the largest slope, because that is where a dormer goes and because
 * putting it high on the slope is the one placement that cannot work — its roof
 * would have to climb over the ridge to meet anything.
 */
export function addDormer(doc: DesignDocument, roofId: string): string | null {
  const roof = doc.roofs.find((entry) => entry.id === roofId);
  if (!roof) return null;

  const geometry = roofGeometry(doc, roof);
  if (!geometry || geometry.planes.length === 0) return null;

  const largest = geometry.planes.reduce((best, plane) =>
    plane.planArea > best.planArea ? plane : best,
  );

  const eaveA = largest.points[0]!;
  const eaveB = largest.points[1]!;
  const middle = { x: (eaveA.x + eaveB.x) / 2, z: (eaveA.z + eaveB.z) / 2 };
  const inward = uphillOf(largest.normal);

  /*
   * Sized to fit the roof it is going into, rather than to a fixed default.
   *
   * A dormer reaches back up the slope by an amount it works out for itself —
   * the taller its face, the further — so a 1 m face that is perfectly ordinary
   * on a big house climbs straight over the ridge of a small one. The run
   * available is measured first, the dormer is stood a quarter of the way up
   * it, and the face height is then whatever leaves the dormer dying into the
   * roof with room to spare.
   *
   * Getting this right matters more than it looks: the alternative is that
   * every dormer anybody adds arrives already reporting a problem, which
   * teaches people to ignore the problems.
   */
  const slopeRun = geometry.rise / Math.max(0.05, roof.pitch);
  const stand = slopeRun * 0.25;
  const available = Math.max(0.5, slopeRun - stand) * 0.75;

  const eaveLength = Math.hypot(eaveB.x - eaveA.x, eaveB.z - eaveA.z);
  const width = clampTo(Math.min(1.6, eaveLength * 0.35), DORMER_LIMITS.width);

  // depth = (faceHeight + half the width at the dormer's pitch) / roof pitch
  const faceHeight = available * roof.pitch - (width / 2) * roof.pitch;

  /*
   * Some roofs have no room for a dormer at all, and saying so is the right
   * answer.
   *
   * A dormer needs enough slope above it for its own roof to run back into the
   * main one, and a small building with a shallow pitch simply does not have
   * it: the shortest dormer worth building would still climb over the ridge.
   * Adding one anyway and letting it report a problem is worse than refusing —
   * it teaches people that the problems are noise.
   */
  if (faceHeight < DORMER_LIMITS.faceHeight.min) return null;

  const id = nextId(roof.dormers, 'dormer');
  roof.dormers.push({
    id,
    kind: 'gable',
    at: { x: middle.x + inward.x * stand, z: middle.z + inward.z * stand },
    width,
    faceHeight,
    pitch: roof.pitch,
    window:
      faceHeight > 0.7
        ? { width: Math.max(0.4, width - 0.5), height: faceHeight - 0.35, sillHeight: 0.15 }
        : null,
  });
  return id;
}

function clampTo(value: number, limits: { min: number; max: number }): number {
  return Math.min(limits.max, Math.max(limits.min, value));
}

export function removeDormer(doc: DesignDocument, roofId: string, dormerId: string): void {
  const roof = doc.roofs.find((entry) => entry.id === roofId);
  if (!roof) return;
  roof.dormers = roof.dormers.filter((dormer) => dormer.id !== dormerId);
}

export function updateDormer(
  doc: DesignDocument,
  roofId: string,
  dormerId: string,
  changes: Partial<Dormer>,
): void {
  const dormer = doc.roofs
    .find((entry) => entry.id === roofId)
    ?.dormers.find((entry) => entry.id === dormerId);
  if (dormer) Object.assign(dormer, changes);
}

/** Adds a skylight, in the middle of the largest slope. */
export function addSkylight(doc: DesignDocument, roofId: string): string | null {
  const roof = doc.roofs.find((entry) => entry.id === roofId);
  if (!roof) return null;

  const geometry = roofGeometry(doc, roof);
  if (!geometry || geometry.planes.length === 0) return null;

  const largest = geometry.planes.reduce((best, plane) =>
    plane.planArea > best.planArea ? plane : best,
  );

  let x = 0;
  let z = 0;
  for (const point of largest.points) {
    x += point.x;
    z += point.z;
  }

  const id = nextId(roof.skylights, 'skylight');
  roof.skylights.push({
    id,
    at: { x: x / largest.points.length, z: z / largest.points.length },
    width: 0.8,
    length: 1.2,
    kind: 'fixed',
    glazing: 'laminated',
    curb: 0.15,
  });
  return id;
}

export function removeSkylight(doc: DesignDocument, roofId: string, skylightId: string): void {
  const roof = doc.roofs.find((entry) => entry.id === roofId);
  if (!roof) return;
  roof.skylights = roof.skylights.filter((skylight) => skylight.id !== skylightId);
}

export function updateSkylight(
  doc: DesignDocument,
  roofId: string,
  skylightId: string,
  changes: Partial<Skylight>,
): void {
  const skylight = doc.roofs
    .find((entry) => entry.id === roofId)
    ?.skylights.find((entry) => entry.id === skylightId);
  if (skylight) Object.assign(skylight, changes);
}

/** Up the slope, in plan, from a roof plane's normal. */
function uphillOf(normal: { x: number; y: number; z: number }): Point2 {
  const horizontal = Math.hypot(normal.x, normal.z);
  if (horizontal < 1e-9) return { x: 0, z: 1 };
  return { x: -normal.x / horizontal, z: -normal.z / horizontal };
}

/* --------------------------------- The site ------------------------------- */

/**
 * Draws a rectangular plot around the building.
 *
 * Not a substitute for a real boundary — plots are rarely rectangles and never
 * centred on the house — but it is the fastest way to get a plot line on the
 * drawing so that setbacks and lot coverage mean something. A user with a
 * survey can move the corners afterwards.
 */
export function setRectangularPlot(doc: DesignDocument, width: number, depth: number): void {
  const halfWidth = Math.max(1, width) / 2;
  const halfDepth = Math.max(1, depth) / 2;

  doc.site.boundary = [
    { x: -halfWidth, z: -halfDepth },
    { x: halfWidth, z: -halfDepth },
    { x: halfWidth, z: halfDepth },
    { x: -halfWidth, z: halfDepth },
  ];

  // The front is the edge the arrangement suggests: the one at -z, which is the
  // bottom of the screen in plan and where a street would be drawn.
  if (doc.site.setbacks) doc.site.setbacks.frontAt = { x: 0, z: -halfDepth };
}
