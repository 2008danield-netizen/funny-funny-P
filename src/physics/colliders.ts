/**
 * Turning the design into colliders.
 *
 * The only interesting decision here is what counts as solid.
 *
 * A wall is solid except where a DOORWAY passes through it, so a sofa can be
 * pushed from one room into another through a door but not through the wall
 * beside it. Windows are not gaps: a window with a sill has wall beneath it, and
 * even a floor-to-ceiling one has glass in it — you cannot walk through either,
 * so neither should a wardrobe. That is why the split below keys on
 * `kind === 'door'` and not on sill height.
 *
 * Rugs are the other special case. They lie on the floor and everything stands
 * on top of them, so they collide with walls (a rug should not run under a wall)
 * but not with furniture.
 */

import { getCatalogEntry } from '@/furniture/catalog';
import { resolveWalls } from '@/scene/planGraph';
import type { Collider, Obb } from './collision';
import type { FurnitureItem, PlanModel } from '@/state/types';

/** The solid spans of every wall, as colliders. */
export function wallColliders(plan: PlanModel): Collider[] {
  const colliders: Collider[] = [];

  for (const segment of resolveWalls(plan)) {
    const { wall, length: wallLength } = segment;
    const rotation = Math.atan2(segment.direction.z, segment.direction.x);
    const halfDepth = wall.thickness / 2;

    // Intervals along the wall that a doorway removes.
    const gaps = wall.openings
      .filter((opening) => opening.kind === 'door')
      .map((opening) => ({
        from: opening.offset - opening.width / 2,
        to: opening.offset + opening.width / 2,
      }))
      .sort((a, b) => a.from - b.from);

    // Walk the wall, emitting a collider for each solid stretch between gaps.
    let cursor = 0;
    const emit = (from: number, to: number) => {
      const span = to - from;
      if (span <= 1e-3) return;
      const mid = (from + to) / 2;
      colliders.push({
        kind: 'wall',
        id: wall.id,
        center: {
          x: segment.start.x + segment.direction.x * mid,
          z: segment.start.z + segment.direction.z * mid,
        },
        halfWidth: span / 2,
        halfDepth,
        rotation,
      });
    };

    for (const gap of gaps) {
      emit(cursor, Math.max(cursor, gap.from));
      cursor = Math.max(cursor, gap.to);
    }
    emit(cursor, wallLength);
  }

  return colliders;
}

/** The dimensions a placed item is actually built to. */
export function itemDimensions(item: FurnitureItem): {
  width: number;
  depth: number;
  height: number;
} {
  const entry = getCatalogEntry(item.catalogId);
  return (
    item.size ?? { width: entry.width, depth: entry.depth, height: entry.height }
  );
}

/** The footprint of a placed item, as an oriented box. */
export function itemFootprint(item: FurnitureItem): Obb {
  const { width, depth } = itemDimensions(item);
  return {
    center: { x: item.x, z: item.z },
    halfWidth: width / 2,
    halfDepth: depth / 2,
    rotation: item.rotation,
  };
}

/**
 * Colliders for everything a given item must avoid.
 *
 * `movingId` is excluded — an item never collides with itself — and rugs are
 * skipped both as obstacles and as things that avoid other furniture.
 */
export function collidersFor(
  plan: PlanModel,
  furniture: readonly FurnitureItem[],
  movingId: string | null,
): Collider[] {
  const colliders = wallColliders(plan);

  const moving = movingId
    ? furniture.find((candidate) => candidate.id === movingId)
    : undefined;
  const movingIsRug =
    moving !== undefined && getCatalogEntry(moving.catalogId).layer === 'floor';

  // A rug only has to stay off the walls; everything else stands on top of it.
  if (movingIsRug) return colliders;

  for (const item of furniture) {
    if (item.id === movingId) continue;
    if (getCatalogEntry(item.catalogId).layer === 'floor') continue;

    const footprint = itemFootprint(item);
    colliders.push({ kind: 'furniture', id: item.id, ...footprint });
  }

  return colliders;
}

/** Colliders for a hypothetical item that is not in the document yet. */
export function collidersForNewItem(
  plan: PlanModel,
  furniture: readonly FurnitureItem[],
  catalogId: string,
): Collider[] {
  const entry = getCatalogEntry(catalogId);
  if (entry.layer === 'floor') return wallColliders(plan);
  return collidersFor(plan, furniture, null);
}
