/**
 * Clearance zones: the patches of floor that need to stay clear.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS FOR
 *
 * Session 3 made it impossible to put a wardrobe inside a wall. That is a
 * necessary guarantee and a low bar — a wardrobe can sit legally in an alcove
 * where its doors cannot open, and a sofa can sit legally 12 cm from a coffee
 * table. Collision answers "does it fit". Clearance answers "does it work",
 * which is the judgement an interior designer is actually paid for.
 *
 * A zone is a rectangle (or, for a door, a quarter-disc approximated as one)
 * projected onto the floor, owned by the thing that needs it. Anything else
 * standing in it is a problem. Deriving zones as geometry rather than as rules
 * in code means they can be drawn, which is most of their value: "blocks the
 * door swing" is far easier to act on when you can see the arc it means.
 * -----------------------------------------------------------------------------
 */

import { getCatalogEntry, type ClearanceSpec } from '@/furniture/catalog';
import { itemDimensions } from '@/physics/colliders';
import type { Obb } from '@/physics/collision';
import { openingCenter, resolveWalls, type WallSegment } from '@/scene/planGraph';
import type { FurnitureItem, PlanModel, Point2 } from '@/state/types';

/** Where a zone came from, so a violation can name it. */
export type ZoneOwner =
  | { kind: 'furniture'; id: string; catalogId: string }
  | { kind: 'opening'; id: string; wallId: string };

export interface ClearanceZone extends Obb {
  /** Unique within one analysis pass. */
  id: string;
  owner: ZoneOwner;
  /** Plain-language reason, shown to the user. */
  label: string;
  severity: 'required' | 'advisory';
}

/* --------------------------- Furniture zones --------------------------- */

/**
 * Builds the zone one clearance spec asks for.
 *
 * The maths is all in the piece's local frame and then rotated out, which is
 * why a zone stays correctly attached when the piece is turned: "in front of"
 * means +Z for the piece, whichever way it happens to be facing in the world.
 */
function zoneForSpec(
  item: FurnitureItem,
  spec: ClearanceSpec,
  size: { width: number; depth: number },
): ClearanceZone {
  const halfWidth = size.width / 2;
  const halfDepth = size.depth / 2;

  // Local offset from the piece's centre to the zone's centre, and the zone's
  // own half-extents. Front/back extend along local Z, left/right along local X.
  let localOffset: Point2;
  let zoneHalfWidth: number;
  let zoneHalfDepth: number;

  switch (spec.side) {
    case 'front':
      localOffset = { x: 0, z: halfDepth + spec.depth / 2 };
      zoneHalfWidth = halfWidth;
      zoneHalfDepth = spec.depth / 2;
      break;
    case 'back':
      localOffset = { x: 0, z: -(halfDepth + spec.depth / 2) };
      zoneHalfWidth = halfWidth;
      zoneHalfDepth = spec.depth / 2;
      break;
    case 'left':
      localOffset = { x: -(halfWidth + spec.depth / 2), z: 0 };
      zoneHalfWidth = spec.depth / 2;
      zoneHalfDepth = halfDepth;
      break;
    case 'right':
    default:
      localOffset = { x: halfWidth + spec.depth / 2, z: 0 };
      zoneHalfWidth = spec.depth / 2;
      zoneHalfDepth = halfDepth;
      break;
  }

  // Rotate the local offset into world space by the piece's own rotation.
  const cos = Math.cos(item.rotation);
  const sin = Math.sin(item.rotation);
  const center = {
    x: item.x + localOffset.x * cos - localOffset.z * sin,
    z: item.z + localOffset.x * sin + localOffset.z * cos,
  };

  return {
    id: `${item.id}:${spec.id}`,
    owner: { kind: 'furniture', id: item.id, catalogId: item.catalogId },
    label: spec.label,
    severity: spec.severity,
    center,
    halfWidth: zoneHalfWidth,
    halfDepth: zoneHalfDepth,
    rotation: item.rotation,
  };
}

/** Every zone required by the furniture in a design. */
export function furnitureZones(furniture: readonly FurnitureItem[]): ClearanceZone[] {
  const zones: ClearanceZone[] = [];

  for (const item of furniture) {
    const entry = getCatalogEntry(item.catalogId);
    if (!entry.clearances) continue;

    const size = itemDimensions(item);
    for (const spec of entry.clearances) {
      zones.push(zoneForSpec(item, spec, size));
    }
  }

  return zones;
}

/* ---------------------------- Opening zones ---------------------------- */

/**
 * Zones for doors and doorways.
 *
 * A hinged door sweeps a quarter-disc of radius equal to its width. That is
 * approximated here by the square the arc is inscribed in, which over-reserves
 * the two corners — deliberately: those corners are where a door catches on a
 * chair leg, and the error is on the side of the user not stubbing a door.
 *
 * An opening with no leaf still gets a shallower approach zone. Standing a
 * bookcase directly in a doorway is a problem whether or not a door swings.
 */
export function openingZones(plan: PlanModel): ClearanceZone[] {
  const zones: ClearanceZone[] = [];

  for (const segment of resolveWalls(plan)) {
    for (const opening of segment.wall.openings) {
      if (opening.kind !== 'door') continue;

      const centre = openingCenter(segment, opening);
      const isSwinging = opening.presetId !== 'door-opening';

      // Swing depth is the door's own width; a cased opening just needs a
      // shallower approach on both sides.
      const depth = isSwinging ? opening.width : 0.5;

      // The zone hugs the wall's face and extends into the room. For a swinging
      // door only the side it opens towards is reserved; a cased opening
      // reserves both, since people walk through it either way.
      const sides: Array<1 | -1> = isSwinging ? [opening.swing === 'a' ? 1 : -1] : [1, -1];

      for (const side of sides) {
        const offset = segment.wall.thickness / 2 + depth / 2;
        zones.push({
          id: `${opening.id}:swing${side > 0 ? 'A' : 'B'}`,
          owner: { kind: 'opening', id: opening.id, wallId: segment.wall.id },
          label: isSwinging ? 'Room for the door to swing open' : 'Room to walk through the doorway',
          severity: 'required',
          center: {
            x: centre.x + segment.normal.x * offset * side,
            z: centre.z + segment.normal.z * offset * side,
          },
          halfWidth: opening.width / 2,
          halfDepth: depth / 2,
          // A zone's local X runs along the wall, so its rotation is the wall's.
          rotation: rotationOf(segment),
        });
      }
    }
  }

  return zones;
}

/** The rotation that aligns a zone's local X with a wall's direction. */
function rotationOf(segment: WallSegment): number {
  return Math.atan2(segment.direction.z, segment.direction.x);
}
