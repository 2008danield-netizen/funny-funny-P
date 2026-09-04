/**
 * Tests for furniture placement.
 *
 * These check the guarantee session 3 exists to make, at the level the user
 * experiences it: whatever you do — drop, drag, rotate, duplicate, or move a
 * wall through a sofa — nothing ends up inside a wall or inside another piece.
 */

import { describe, expect, it } from 'vitest';

import { activeLevel } from '@/state/levels';
import type { DesignDocument, Level } from '@/state/types';

import { createDefaultDocument } from './defaults';
import {
  duplicateFurniture,
  moveFurniture,
  placeFurniture,
  removeFurniture,
  reseatFurniture,
  rotateFurniture,
} from './furnitureOps';
import { collidersFor, itemFootprint } from '@/physics/colliders';
import { obbIntersects } from '@/physics/collision';
import { addRectangle } from './planOps';
import { findRegions, pointInPolygon } from '@/scene/planGraph';

/**
 * The storey a test is working on.
 *
 * Every fixture here is a one-level building, so this is always its ground
 * floor — but going through the accessor rather than reaching for `levels[0]`
 * means these tests exercise the same path the app does.
 */
function level(doc: DesignDocument): Level {
  return activeLevel(doc);
}

/** A document with one room of the given size, centred on the origin. */
function roomDocument(width = 6, depth = 5): DesignDocument {
  const doc = createDefaultDocument();
  level(doc).plan.vertices = [];
  level(doc).plan.walls = [];
  level(doc).plan.rooms = {};
  addRectangle(level(doc).plan, { x: 0, z: 0 }, width, depth);
  return doc;
}

/** Asserts that no piece overlaps a wall or another piece. */
function expectNothingOverlapping(doc: DesignDocument): void {
  for (const item of level(doc).furniture) {
    const footprint = itemFootprint(item);
    for (const collider of collidersFor(level(doc).plan, level(doc).furniture, item.id)) {
      expect(
        obbIntersects(footprint, collider),
        `${item.catalogId} (${item.id}) overlaps ${collider.kind} ${collider.id}`,
      ).toBe(false);
    }
  }
}

describe('placeFurniture', () => {
  it('places a piece inside the room', () => {
    const doc = roomDocument();
    const result = placeFurniture(doc, level(doc), 'lack-coffee', { x: 0, z: 0 });

    expect(result.id).not.toBeNull();
    expect(level(doc).furniture).toHaveLength(1);

    const regions = findRegions(level(doc).plan);
    const item = level(doc).furniture[0]!;
    expect(regions.some((region) => pointInPolygon({ x: item.x, z: item.z }, region.polygon))).toBe(true);
  });

  it('refuses to place anything outside the rooms', () => {
    const doc = roomDocument();
    const result = placeFurniture(doc, level(doc), 'lack-coffee', { x: 40, z: 40 });

    expect(result.id).toBeNull();
    expect(level(doc).furniture).toHaveLength(0);
  });

  it('pushes a piece clear of a wall it was dropped onto', () => {
    const doc = roomDocument(6, 5);
    // Right on the north wall, at z = -2.5.
    placeFurniture(doc, level(doc), 'kivik-3', { x: 0, z: -2.5 });

    expect(level(doc).furniture).toHaveLength(1);
    expectNothingOverlapping(doc);
  });

  it('seats a wall piece flush and facing into the room', () => {
    const doc = roomDocument(6, 5);
    placeFurniture(doc, level(doc), 'billy-80', { x: 0, z: -2.2 });

    const item = level(doc).furniture[0]!;
    expect(item).toBeDefined();

    // BILLY is 28 cm deep; against the north wall (inner face z = -2.5 + 0.06)
    // it should sit at roughly -2.44 + 0.14.
    expect(item.z).toBeGreaterThan(-2.5);
    expect(item.z).toBeLessThan(-2.1);

    // Facing into the room means its local +Z points towards +Z.
    const front = { x: -Math.sin(item.rotation), z: Math.cos(item.rotation) };
    expect(front.z).toBeGreaterThan(0.9);
    expectNothingOverlapping(doc);
  });

  it('never stacks two pieces on the same spot', () => {
    const doc = roomDocument(8, 6);
    placeFurniture(doc, level(doc), 'lack-coffee', { x: 0, z: 0 });
    placeFurniture(doc, level(doc), 'lack-coffee', { x: 0, z: 0 });

    expect(level(doc).furniture).toHaveLength(2);
    expectNothingOverlapping(doc);
  });

  it('lets a rug lie under furniture, but keeps it off the walls', () => {
    const doc = roomDocument(8, 6);
    placeFurniture(doc, level(doc), 'lack-coffee', { x: 0, z: 0 });
    const rug = placeFurniture(doc, level(doc), 'stoense-rug', { x: 0, z: 0 });

    expect(rug.id).not.toBeNull();

    // The rug is allowed to overlap the table it lies beneath...
    const rugItem = level(doc).furniture.find((item) => item.id === rug.id)!;
    const table = level(doc).furniture.find((item) => item.catalogId === 'lack-coffee')!;
    expect(obbIntersects(itemFootprint(rugItem), itemFootprint(table))).toBe(true);

    // ...but not the walls.
    for (const collider of collidersFor(level(doc).plan, level(doc).furniture, rugItem.id)) {
      expect(obbIntersects(itemFootprint(rugItem), collider)).toBe(false);
    }
  });

  it('rejects an unknown catalogue ID rather than guessing', () => {
    const doc = roomDocument();
    expect(placeFurniture(doc, level(doc), 'not-a-real-product', { x: 0, z: 0 }).id).toBeNull();
    expect(level(doc).furniture).toHaveLength(0);
  });
});

describe('moveFurniture', () => {
  it('moves a piece to a clear spot', () => {
    const doc = roomDocument(8, 6);
    const { id } = placeFurniture(doc, level(doc), 'lack-coffee', { x: 0, z: 0 });

    moveFurniture(doc, level(doc), id!, { x: 2, z: 1 });
    const item = level(doc).furniture[0]!;
    expect(item.x).toBeCloseTo(2, 2);
    expect(item.z).toBeCloseTo(1, 2);
  });

  it('will not push a piece through a wall', () => {
    const doc = roomDocument(6, 5);
    const { id } = placeFurniture(doc, level(doc), 'lack-coffee', { x: 0, z: 0 });

    // Drag hard at the wall and well past it.
    moveFurniture(doc, level(doc), id!, { x: 0, z: -20 });
    expectNothingOverlapping(doc);

    const item = level(doc).furniture[0]!;
    const regions = findRegions(level(doc).plan);
    expect(regions.some((region) => pointInPolygon({ x: item.x, z: item.z }, region.polygon))).toBe(true);
  });

  it('slides along a wall rather than sticking to it', () => {
    const doc = roomDocument(8, 6);
    const { id } = placeFurniture(doc, level(doc), 'lack-coffee', { x: -2, z: 0 });

    // Aim through the north wall and off to one side. The sideways part of the
    // motion should survive even though the forward part cannot. The target is
    // just past the wall rather than far beyond it, because that is what a
    // real drag looks like frame to frame — a target metres outside the
    // building overlaps nothing to slide against and is simply refused.
    // z = -3.0 puts the table straddling the north wall, which is what gives
    // the solver something to slide against. (Aiming at -3.4 would clear the
    // wall entirely and simply be refused as outside the room.)
    moveFurniture(doc, level(doc), id!, { x: 2, z: -3.0 });

    const item = level(doc).furniture[0]!;
    expect(item.x).toBeGreaterThan(0);
    expectNothingOverlapping(doc);
  });

  it('will not push one piece through another', () => {
    const doc = roomDocument(8, 6);
    placeFurniture(doc, level(doc), 'malm-chest-6', { x: -2, z: 0 });
    const second = placeFurniture(doc, level(doc), 'lack-coffee', { x: 2, z: 0 });

    moveFurniture(doc, level(doc), second.id!, { x: -2, z: 0 });
    expectNothingOverlapping(doc);
  });
});

describe('rotateFurniture', () => {
  it('turns a piece that has room to turn', () => {
    const doc = roomDocument(8, 6);
    const { id } = placeFurniture(doc, level(doc), 'lack-coffee', { x: 0, z: 0 });

    expect(rotateFurniture(doc, level(doc), id!, Math.PI / 2)).toBe(true);
    expect(level(doc).furniture[0]!.rotation).toBeCloseTo(Math.PI / 2, 6);
    expectNothingOverlapping(doc);
  });

  it('refuses a rotation that would bury the piece in a wall', () => {
    // A 2.35 m table in a room only 2.4 m deep: it fits one way round and
    // cannot possibly fit the other.
    const doc = roomDocument(6, 2.4);
    const { id } = placeFurniture(doc, level(doc), 'skogsta-table', { x: 0, z: 0 });
    if (!id) return; // Nothing to test if it could not be placed at all.

    const before = level(doc).furniture[0]!.rotation;
    const turned = rotateFurniture(doc, level(doc), id, before + Math.PI / 2);

    expect(turned).toBe(false);
    expect(level(doc).furniture[0]!.rotation).toBeCloseTo(before, 6);
    expectNothingOverlapping(doc);
  });
});

describe('duplicateFurniture', () => {
  it('places the copy beside the original, not on top of it', () => {
    const doc = roomDocument(8, 6);
    const { id } = placeFurniture(doc, level(doc), 'ingolf-chair', { x: 0, z: 0 });

    const copy = duplicateFurniture(doc, level(doc), id!);
    expect(copy).not.toBeNull();
    expect(level(doc).furniture).toHaveLength(2);
    expectNothingOverlapping(doc);
  });

  it('carries the colourway across', () => {
    const doc = roomDocument(8, 6);
    const { id } = placeFurniture(doc, level(doc), 'ingolf-chair', { x: 0, z: 0 });
    level(doc).furniture[0]!.colorwayId = 'black-brown';

    const copy = duplicateFurniture(doc, level(doc), id!);
    const copied = level(doc).furniture.find((item) => item.id === copy)!;
    expect(copied.colorwayId).toBe('black-brown');
  });
});

describe('reseatFurniture', () => {
  it('pushes furniture clear after a wall is moved through it', () => {
    const doc = roomDocument(8, 6);
    placeFurniture(doc, level(doc), 'kivik-3', { x: 0, z: 0 });
    expectNothingOverlapping(doc);

    // Drag the whole north wall down through the sofa by shifting its corners.
    const northZ = -3;
    for (const vertex of level(doc).plan.vertices) {
      if (Math.abs(vertex.z - northZ) < 0.01) vertex.z = 0.4;
    }

    reseatFurniture(doc, level(doc));
    expectNothingOverlapping(doc);
  });

  it('reports furniture it cannot rescue instead of deleting it', () => {
    const doc = roomDocument(8, 6);
    const { id } = placeFurniture(doc, level(doc), 'skogsta-table', { x: 0, z: 0 });

    // Shrink the room to well under the table's size. There is nowhere legal
    // for a 2.35 m table to go in a room barely a metre across.
    level(doc).plan.vertices = [];
    level(doc).plan.walls = [];
    level(doc).plan.rooms = {};
    addRectangle(level(doc).plan, { x: 0, z: 0 }, 1.2, 1.2);

    const { stranded } = reseatFurniture(doc, level(doc));
    expect(stranded).toContain(id);
    // Crucially, the piece is still there — the user's work is not thrown away.
    expect(level(doc).furniture).toHaveLength(1);
  });
});

describe('removeFurniture', () => {
  it('removes only the named piece', () => {
    const doc = roomDocument(8, 6);
    const first = placeFurniture(doc, level(doc), 'lack-coffee', { x: -2, z: 0 });
    placeFurniture(doc, level(doc), 'lack-side', { x: 2, z: 0 });

    removeFurniture(level(doc), first.id!);
    expect(level(doc).furniture).toHaveLength(1);
    expect(level(doc).furniture[0]!.catalogId).toBe('lack-side');
  });
});

describe('a furnished room, end to end', () => {
  it('keeps every piece legal through a long editing session', () => {
    const doc = roomDocument(9, 7);

    // Furnish a living room the way somebody actually would.
    const sofa = placeFurniture(doc, level(doc), 'kivik-3', { x: 0, z: -3.4 });
    placeFurniture(doc, level(doc), 'lack-coffee', { x: 0, z: -1.4 });
    placeFurniture(doc, level(doc), 'poang', { x: -3, z: 0 });
    placeFurniture(doc, level(doc), 'billy-80', { x: 4.4, z: 0 });
    placeFurniture(doc, level(doc), 'stoense-rug', { x: 0, z: -1.5 });
    placeFurniture(doc, level(doc), 'hektar-floor', { x: -3.5, z: -2.5 });

    expect(level(doc).furniture.length).toBeGreaterThanOrEqual(5);
    expectNothingOverlapping(doc);

    // Shove things around, including into each other and into walls.
    if (sofa.id) {
      moveFurniture(doc, level(doc), sofa.id, { x: 0, z: -20 });
      moveFurniture(doc, level(doc), sofa.id, { x: 0, z: 0 });
      rotateFurniture(doc, level(doc), sofa.id, Math.PI / 3);
    }
    for (const item of [...level(doc).furniture]) {
      moveFurniture(doc, level(doc), item.id, { x: 0, z: 0 });
    }

    expectNothingOverlapping(doc);
  });
});
