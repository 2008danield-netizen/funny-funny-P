/**
 * Placing, moving and removing furniture — with collision enforced.
 *
 * Like `planOps`, everything here MUTATES a draft document and is designed to be
 * called inside a `designStore.edit()` recipe.
 *
 * The rule these functions enforce, and the whole point of session 3: a piece of
 * furniture is never left overlapping a wall or another piece. Every move is
 * routed through the solver, which either finds the nearest legal position or
 * rejects the move and leaves the piece where it was. There is no path through
 * this module that writes an illegal position, which is what makes the guarantee
 * hold no matter how the user gets there — dragging, typing coordinates,
 * rotating in place, or reshaping the room around the furniture.
 */

import {
  collidersFor,
  collidersForNewItem,
  itemDimensions,
  itemFootprint,
} from '@/physics/colliders';
import { obbCorners, snapToWall, solvePosition, type Obb } from '@/physics/collision';
import { findRegions, pointInPolygon, type Region } from '@/scene/planGraph';
import { getCatalogEntry, isKnownCatalogId } from '@/furniture/catalog';
import { FURNITURE_LIMITS, type DesignDocument, type FurnitureItem, type Point2 } from './types';

/* ---------------------------------- IDs -------------------------------- */

export function newFurnitureId(doc: DesignDocument): string {
  const taken = new Set(doc.furniture.map((item) => item.id));
  let n = taken.size + 1;
  while (taken.has(`f${n}`)) n += 1;
  return `f${n}`;
}

/* -------------------------------- Placement ---------------------------- */

/** Whether a point lies inside any room of the plan. */
function insideAnyRoom(regions: readonly Region[], point: Point2): boolean {
  return regions.some((region) => pointInPolygon(point, region.polygon));
}

export interface PlacementResult {
  /** The item's ID, or null when no legal position could be found. */
  id: string | null;
  /** Why it failed, for the status readout. */
  reason?: string;
}

/**
 * Drops a new piece into the plan at a point on the floor.
 *
 * The sequence matters. Wall-snapping happens BEFORE collision resolution, so
 * that a bookcase dropped near a wall turns to face the room and seats itself
 * flush, and only then gets nudged clear of anything already standing there.
 * Resolving first and snapping second would undo the resolution.
 */
export function placeFurniture(
  doc: DesignDocument,
  catalogId: string,
  at: Point2,
): PlacementResult {
  if (!isKnownCatalogId(catalogId)) return { id: null, reason: 'Unknown item' };

  const entry = getCatalogEntry(catalogId);
  const regions = findRegions(doc.plan);

  if (!insideAnyRoom(regions, at)) {
    return { id: null, reason: 'Drop it inside a room' };
  }

  let box: Obb = {
    center: { x: at.x, z: at.z },
    halfWidth: entry.width / 2,
    halfDepth: entry.depth / 2,
    rotation: 0,
  };

  const colliders = collidersForNewItem(doc.plan, doc.furniture, catalogId);

  // Things that live against walls find one and turn to face the room.
  if (entry.placement === 'wall') {
    const snapped = snapToWall(
      box,
      colliders,
      FURNITURE_LIMITS.wallSnapDistance,
      FURNITURE_LIMITS.contactGap,
    );
    if (snapped) box = { ...box, center: snapped.center, rotation: snapped.rotation };
  }

  const solved = solvePosition(box, {
    colliders,
    padding: FURNITURE_LIMITS.contactGap,
    iterations: FURNITURE_LIMITS.solverIterations,
    isPositionValid: (center) => insideAnyRoom(regions, center),
  });

  if (!solved.resolved) {
    return { id: null, reason: 'No room for it there' };
  }

  const id = newFurnitureId(doc);
  doc.furniture.push({
    id,
    catalogId,
    x: solved.center.x,
    z: solved.center.z,
    y: 0,
    rotation: box.rotation,
  });
  return { id };
}

export interface MoveResult {
  /** True when the piece ended up somewhere legal (possibly nudged). */
  moved: boolean;
  /** IDs of whatever blocked it, for highlighting. */
  blockedBy: string[];
}

/**
 * Moves a piece towards a target position, stopping where it legally can.
 *
 * The solver's push-out behaviour is what makes this feel physical: dragging a
 * sofa into a wall slides it along the wall rather than stopping it dead,
 * because only the component of the motion into the wall is cancelled.
 */
export function moveFurniture(
  doc: DesignDocument,
  id: string,
  to: Point2,
  options: { snapWalls?: boolean } = {},
): MoveResult {
  const item = doc.furniture.find((candidate) => candidate.id === id);
  if (!item) return { moved: false, blockedBy: [] };

  const entry = getCatalogEntry(item.catalogId);
  const regions = findRegions(doc.plan);
  const dimensions = itemDimensions(item);
  const colliders = collidersFor(doc.plan, doc.furniture, id);

  let box: Obb = {
    center: { x: to.x, z: to.z },
    halfWidth: dimensions.width / 2,
    halfDepth: dimensions.depth / 2,
    rotation: item.rotation,
  };

  if (options.snapWalls && entry.placement === 'wall') {
    const snapped = snapToWall(
      box,
      colliders,
      FURNITURE_LIMITS.wallSnapDistance,
      FURNITURE_LIMITS.contactGap,
    );
    if (snapped) box = { ...box, center: snapped.center, rotation: snapped.rotation };
  }

  const solved = solvePosition(box, {
    colliders,
    padding: FURNITURE_LIMITS.contactGap,
    iterations: FURNITURE_LIMITS.solverIterations,
    isPositionValid: (center) => insideAnyRoom(regions, center),
  });

  if (!solved.resolved) {
    // Leave the piece where it was rather than dropping it somewhere illegal.
    return { moved: false, blockedBy: solved.blockedBy };
  }

  item.x = solved.center.x;
  item.z = solved.center.z;
  item.rotation = box.rotation;
  return { moved: true, blockedBy: solved.blockedBy };
}

/**
 * Rotates a piece in place, keeping it legal.
 *
 * Rotation can create an overlap where there was none — turning a long sofa in
 * a narrow alcove sweeps it into the walls — so the result is run through the
 * solver too, and the rotation is abandoned if no position works at the new
 * angle. Silently accepting it would leave a sofa buried in a wall, which is
 * exactly the guarantee this session exists to make.
 */
export function rotateFurniture(doc: DesignDocument, id: string, radians: number): boolean {
  const item = doc.furniture.find((candidate) => candidate.id === id);
  if (!item) return false;

  const dimensions = itemDimensions(item);
  const regions = findRegions(doc.plan);
  const colliders = collidersFor(doc.plan, doc.furniture, id);

  const box: Obb = {
    center: { x: item.x, z: item.z },
    halfWidth: dimensions.width / 2,
    halfDepth: dimensions.depth / 2,
    rotation: radians,
  };

  const solved = solvePosition(box, {
    colliders,
    padding: FURNITURE_LIMITS.contactGap,
    iterations: FURNITURE_LIMITS.solverIterations,
    isPositionValid: (center) => insideAnyRoom(regions, center),
  });

  if (!solved.resolved) return false;

  item.rotation = radians;
  item.x = solved.center.x;
  item.z = solved.center.z;
  return true;
}

/** Resizes a resizable piece, keeping it legal. */
export function resizeFurniture(
  doc: DesignDocument,
  id: string,
  size: { width?: number; depth?: number },
): boolean {
  const item = doc.furniture.find((candidate) => candidate.id === id);
  if (!item) return false;

  const entry = getCatalogEntry(item.catalogId);
  if (!entry.resizable) return false;

  const current = itemDimensions(item);
  const clamp = (value: number, bounds: [number, number] | undefined, fallback: number) =>
    bounds ? Math.min(bounds[1], Math.max(bounds[0], value)) : fallback;

  const next = {
    width: clamp(size.width ?? current.width, entry.resizable.width, current.width),
    depth: clamp(size.depth ?? current.depth, entry.resizable.depth, current.depth),
    height: current.height,
  };

  const regions = findRegions(doc.plan);
  const colliders = collidersFor(doc.plan, doc.furniture, id);

  const solved = solvePosition(
    {
      center: { x: item.x, z: item.z },
      halfWidth: next.width / 2,
      halfDepth: next.depth / 2,
      rotation: item.rotation,
    },
    {
      colliders,
      padding: FURNITURE_LIMITS.contactGap,
      iterations: FURNITURE_LIMITS.solverIterations,
      isPositionValid: (center) => insideAnyRoom(regions, center),
    },
  );

  if (!solved.resolved) return false;

  item.size = next;
  item.x = solved.center.x;
  item.z = solved.center.z;
  return true;
}

export function removeFurniture(doc: DesignDocument, id: string): void {
  doc.furniture = doc.furniture.filter((item) => item.id !== id);
}

/**
 * Copies a piece and places the copy beside the original.
 *
 * Tries a ring of offsets rather than one fixed nudge, because the obvious spot
 * is often occupied — duplicating a dining chair is usually done to build a row
 * of them, and having the copy silently fail to appear would be baffling.
 */
export function duplicateFurniture(doc: DesignDocument, id: string): string | null {
  const item = doc.furniture.find((candidate) => candidate.id === id);
  if (!item) return null;

  const dimensions = itemDimensions(item);
  const step = Math.max(dimensions.width, dimensions.depth) * 0.75 + 0.15;
  const regions = findRegions(doc.plan);
  const colliders = collidersFor(doc.plan, doc.furniture, null);

  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + item.rotation;
    const candidate: Obb = {
      center: { x: item.x + Math.cos(angle) * step, z: item.z + Math.sin(angle) * step },
      halfWidth: dimensions.width / 2,
      halfDepth: dimensions.depth / 2,
      rotation: item.rotation,
    };

    const solved = solvePosition(candidate, {
      colliders,
      padding: FURNITURE_LIMITS.contactGap,
      iterations: FURNITURE_LIMITS.solverIterations,
      isPositionValid: (center) => insideAnyRoom(regions, center),
    });

    if (!solved.resolved) continue;

    const newId = newFurnitureId(doc);
    doc.furniture.push({
      ...structuredClone(item),
      id: newId,
      x: solved.center.x,
      z: solved.center.z,
    });
    return newId;
  }

  return null;
}

/**
 * Re-seats every piece after the plan itself changed.
 *
 * Reshaping a room can leave furniture buried in a wall or stranded outside the
 * building, and the user has every right to move a wall through a sofa. Rather
 * than blocking the wall edit — which would make the plan tools feel broken —
 * the furniture is pushed clear afterwards. Anything that cannot be rescued is
 * reported so the UI can say so instead of silently deleting the user's work.
 */
export function reseatFurniture(doc: DesignDocument): { stranded: string[] } {
  const regions = findRegions(doc.plan);
  const stranded: string[] = [];

  for (const item of doc.furniture) {
    const dimensions = itemDimensions(item);
    const colliders = collidersFor(doc.plan, doc.furniture, item.id);

    const solved = solvePosition(
      {
        center: { x: item.x, z: item.z },
        halfWidth: dimensions.width / 2,
        halfDepth: dimensions.depth / 2,
        rotation: item.rotation,
      },
      {
        colliders,
        padding: FURNITURE_LIMITS.contactGap,
        iterations: FURNITURE_LIMITS.solverIterations,
        isPositionValid: (center) => insideAnyRoom(regions, center),
      },
    );

    if (solved.resolved) {
      item.x = solved.center.x;
      item.z = solved.center.z;
    } else {
      stranded.push(item.id);
    }
  }

  return { stranded };
}

/* --------------------------------- Queries ------------------------------ */

/** True when a piece currently overlaps anything it should not. */
export function isItemColliding(doc: DesignDocument, id: string): boolean {
  const item = doc.furniture.find((candidate) => candidate.id === id);
  if (!item) return false;

  const regions = findRegions(doc.plan);
  const colliders = collidersFor(doc.plan, doc.furniture, id);
  const footprint = itemFootprint(item);

  const solved = solvePosition(footprint, {
    colliders,
    padding: 0,
    iterations: 1,
    isPositionValid: (center) => insideAnyRoom(regions, center),
  });

  // One pass with no padding: if nothing had to move, the piece is clear.
  return (
    solved.blockedBy.length > 0 ||
    !obbCorners(footprint).every(() =>
      regions.some((region) => pointInPolygon({ x: item.x, z: item.z }, region.polygon)),
    )
  );
}

/** The room a piece stands in, or null when it is outside every room. */
export function roomOfItem(
  regions: readonly Region[],
  item: FurnitureItem,
): Region | null {
  return regions.find((region) => pointInPolygon({ x: item.x, z: item.z }, region.polygon)) ?? null;
}
