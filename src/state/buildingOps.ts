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
import {
  activeLevel,
  defaultLevelName,
  levelAbove,
  levelBelow,
  levelIndex,
  riseAbove,
} from './levels';
import { normalizePlan } from './planOps';
import { LEVEL_LIMITS, type DesignDocument, type Level, type Point2 } from './types';

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
