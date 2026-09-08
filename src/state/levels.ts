/**
 * Working with storeys.
 *
 * The one rule this module exists to enforce: **a level's height above the
 * ground is derived, never stored.** It is the sum of the wall heights and
 * slab thicknesses beneath it. Storing it as well would be the same fact
 * written down twice, and the two would part company the first time somebody
 * raised a ground-floor ceiling — leaving a first floor hanging in the air or
 * buried in the storey below, with nothing in the app to say which number was
 * right.
 *
 * That is the same principle rooms already follow (`findRegions` recomputes
 * them from the walls rather than storing them), and for the same reason.
 */

import type { DesignDocument, FloorVoid, Level, Point2, Stair } from './types';

/** The level the editor is currently working on. Never null. */
export function activeLevel(doc: DesignDocument): Level {
  return doc.levels.find((level) => level.id === doc.activeLevelId) ?? doc.levels[0]!;
}

export function levelById(doc: DesignDocument, id: string): Level | null {
  return doc.levels.find((level) => level.id === id) ?? null;
}

export function levelIndex(doc: DesignDocument, id: string): number {
  return doc.levels.findIndex((level) => level.id === id);
}

/** The storey below, or null on the lowest one. */
export function levelBelow(doc: DesignDocument, id: string): Level | null {
  const index = levelIndex(doc, id);
  return index > 0 ? doc.levels[index - 1]! : null;
}

/** The storey above, or null on the top one. */
export function levelAbove(doc: DesignDocument, id: string): Level | null {
  const index = levelIndex(doc, id);
  return index >= 0 && index < doc.levels.length - 1 ? doc.levels[index + 1]! : null;
}

/**
 * Height of a level's FINISHED FLOOR above the site datum, in metres.
 *
 * The lowest level sits at zero by definition — it is the datum. Each level
 * above starts at the top of the walls below it, plus the thickness of the
 * floor structure between them.
 */
export function elevationOf(doc: DesignDocument, id: string): number {
  let elevation = 0;
  for (const level of doc.levels) {
    if (level.id === id) return elevation;
    elevation += level.wallHeight + level.slabThickness;
  }
  return elevation;
}

/**
 * Floor-to-floor rise from one level to the next, in metres.
 *
 * This is the total a staircase has to climb, and it is what the riser height
 * is divided out of — not the ceiling height, which is the number people quote
 * and which would leave a stair short by the thickness of the floor above.
 */
export function riseAbove(doc: DesignDocument, id: string): number {
  const level = levelById(doc, id);
  const above = levelAbove(doc, id);
  if (!level || !above) return 0;
  return level.wallHeight + above.slabThickness;
}

/** Total height of the building, floor of the lowest to top of the highest. */
export function buildingHeight(doc: DesignDocument): number {
  return doc.levels.reduce(
    (total, level) => total + level.wallHeight + level.slabThickness,
    0,
  );
}

/* --------------------------------- Voids --------------------------------- */

/**
 * Every hole in a level's floor: the ones drawn by hand, plus the ones the
 * stairs arriving at this level require.
 *
 * Derived rather than stored, which is what stops a staircase ever arriving at
 * a solid ceiling. Move the stair and the hole moves with it; delete the stair
 * and the hole closes.
 */
export function floorHoles(
  doc: DesignDocument,
  levelId: string,
  stairFootprint: (stair: Stair) => Point2[],
): FloorVoid[] {
  const holes: FloorVoid[] = [...(levelById(doc, levelId)?.voids ?? [])];
  const below = levelBelow(doc, levelId);
  if (!below) return holes;

  for (const stair of doc.stairs) {
    if (stair.fromLevelId !== below.id) continue;
    const polygon = stairFootprint(stair);
    if (polygon.length < 3) continue;
    holes.push({ id: `stairwell:${stair.id}`, polygon, name: `${stair.name} opening` });
  }

  return holes;
}

/** The stairs standing on a level. */
export function stairsOn(doc: DesignDocument, levelId: string): Stair[] {
  return doc.stairs.filter((stair) => stair.fromLevelId === levelId);
}

/** The stairs arriving at a level from the storey below. */
export function stairsInto(doc: DesignDocument, levelId: string): Stair[] {
  const below = levelBelow(doc, levelId);
  if (!below) return [];
  return doc.stairs.filter((stair) => stair.fromLevelId === below.id);
}

/* -------------------------------- Naming --------------------------------- */

/**
 * The name a newly added storey gets.
 *
 * US convention, since that is the code the app is built to: the floor at
 * ground level is the First Floor, the one above it the Second, and so on —
 * not the British counting where the first floor is one flight up. Getting
 * this wrong is a small thing that makes an app feel foreign to the person
 * using it.
 */
export function defaultLevelName(indexFromGround: number): string {
  if (indexFromGround < 0) {
    return indexFromGround === -1 ? 'Basement' : `Basement ${-indexFromGround}`;
  }
  const ordinals = [
    'First Floor',
    'Second Floor',
    'Third Floor',
    'Fourth Floor',
    'Fifth Floor',
    'Sixth Floor',
  ];
  return ordinals[indexFromGround] ?? `Floor ${indexFromGround + 1}`;
}
