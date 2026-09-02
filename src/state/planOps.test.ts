/**
 * Tests for structural plan edits.
 *
 * These operations run on every frame of a drag, so the failure they guard
 * against is not a crash but slow corruption: zero-length walls, vertices
 * connected to nothing, doors left hanging off the end of a shortened wall.
 * None of that is visible immediately, and all of it eventually stops rooms
 * being detected.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultPlan, defaultRoomSpec } from './defaults';
import {
  addOpening,
  addRectangle,
  deleteVertex,
  deleteWall,
  drawWall,
  moveVertex,
  normalizePlan,
  resolveRoomSpec,
  setRoomSpec,
  splitWall,
} from './planOps';
import { findRegions } from '@/scene/planGraph';
import type { PlanModel } from './types';

function emptyPlan(): PlanModel {
  return {
    vertices: [],
    walls: [],
    rooms: {},
    defaultRoom: defaultRoomSpec(),
    defaultWallHeight: 2.6,
    defaultWallThickness: 0.12,
  };
}

describe('addRectangle', () => {
  it('creates a closed, detectable room', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 4, 3);

    expect(plan.vertices).toHaveLength(4);
    expect(plan.walls).toHaveLength(4);
    expect(findRegions(plan)[0]!.area).toBeCloseTo(12, 6);
  });

  it('keeps two rooms separate when they do not touch', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 4, 3);
    addRectangle(plan, { x: 10, z: 0 }, 4, 3);

    expect(findRegions(plan)).toHaveLength(2);
  });
});

describe('normalizePlan', () => {
  it('merges corners dragged onto each other', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 4, 3);

    const [first, second] = plan.vertices;
    // Drop one corner almost exactly onto another. Visually they are the same
    // point; without merging, the graph still sees two and the room opens up.
    moveVertex(plan, second!.id, { x: first!.x + 0.005, z: first!.z + 0.005 });
    normalizePlan(plan);

    expect(plan.vertices.length).toBeLessThan(4);
  });

  it('removes walls left with no length', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 4, 3);
    const before = plan.walls.length;

    const [first, second] = plan.vertices;
    moveVertex(plan, second!.id, { x: first!.x, z: first!.z });
    normalizePlan(plan);

    expect(plan.walls.length).toBeLessThan(before);
  });

  it('prunes vertices no wall refers to', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 4, 3);
    plan.vertices.push({ id: 'orphan', x: 20, z: 20 });

    normalizePlan(plan);
    expect(plan.vertices.some((vertex) => vertex.id === 'orphan')).toBe(false);
  });

  it('refits an opening when its wall is shortened', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 6, 3);

    const wall = plan.walls[0]!;
    addOpening(plan, wall.id, 'door', 'door-single', { width: 0.9, height: 2.04, sillHeight: 0 }, 5);
    expect(wall.openings[0]!.offset).toBeCloseTo(5, 2);

    // Pull the far corner right in, so the wall is now 2 m long while the door
    // still claims to sit 5 m along it.
    const start = plan.vertices.find((vertex) => vertex.id === wall.start)!;
    moveVertex(plan, wall.end, { x: start.x + 2, z: start.z });
    normalizePlan(plan);

    const remaining = plan.walls.find((candidate) => candidate.id === wall.id)!;
    expect(remaining.openings).toHaveLength(1);

    const opening = remaining.openings[0]!;
    // Refitted inside the shortened wall, with a margin at each end.
    expect(opening.offset).toBeGreaterThan(0);
    expect(opening.offset + opening.width / 2).toBeLessThanOrEqual(2);
  });
});

describe('splitWall', () => {
  it('inserts a corner and keeps the room closed', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 4, 3);

    const created = splitWall(plan, plan.walls[0]!.id, 0.5);
    expect(created).not.toBeNull();
    expect(plan.vertices).toHaveLength(5);
    expect(plan.walls).toHaveLength(5);
    // Adding a collinear corner must not change the room's area.
    expect(findRegions(plan)[0]!.area).toBeCloseTo(12, 6);
  });

  it('hands each opening to the half of the wall it now sits in', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 8, 3);

    const wall = plan.walls[0]!;
    addOpening(plan, wall.id, 'window', 'window-casement', { width: 1, height: 1.2, sillHeight: 0.9 }, 1.5);
    addOpening(plan, wall.id, 'window', 'window-casement', { width: 1, height: 1.2, sillHeight: 0.9 }, 6.5);

    splitWall(plan, wall.id, 0.5);

    const total = plan.walls.reduce((sum, candidate) => sum + candidate.openings.length, 0);
    expect(total).toBe(2);
    // Each half should carry exactly one, with offsets rebased onto it.
    for (const candidate of plan.walls) {
      for (const opening of candidate.openings) {
        expect(opening.offset).toBeGreaterThan(0);
        expect(opening.offset).toBeLessThan(4.5);
      }
    }
  });
});

describe('deleteVertex', () => {
  it('joins the two walls either side, keeping the room closed', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 4, 3);

    // Add a redundant corner in the middle of one wall, then remove it again.
    const created = splitWall(plan, plan.walls[0]!.id, 0.5)!;
    expect(plan.walls).toHaveLength(5);

    deleteVertex(plan, created);

    expect(plan.walls).toHaveLength(4);
    expect(plan.vertices).toHaveLength(4);
    expect(findRegions(plan)[0]!.area).toBeCloseTo(12, 6);
  });

  it('removes every attached wall at a corner where three or more meet', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 4, 3);
    const corner = plan.vertices[0]!;
    drawWall(plan, { x: corner.x, z: corner.z }, { x: corner.x - 3, z: corner.z - 3 });

    deleteVertex(plan, corner.id);
    expect(findRegions(plan)).toHaveLength(0);
  });
});

describe('drawWall', () => {
  it('joins onto an existing corner rather than sitting beside it', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 4, 3);
    const before = plan.vertices.length;

    const corner = plan.vertices[0]!;
    // End the new wall a couple of centimetres from an existing corner: it must
    // snap onto it, or the plan looks joined while the graph sees a gap.
    drawWall(plan, { x: 10, z: 10 }, { x: corner.x + 0.02, z: corner.z + 0.02 });

    expect(plan.vertices.length).toBe(before + 1);
  });

  it('closes a room when the last wall completes the loop', () => {
    const plan = emptyPlan();
    drawWall(plan, { x: 0, z: 0 }, { x: 4, z: 0 });
    drawWall(plan, { x: 4, z: 0 }, { x: 4, z: 4 });
    drawWall(plan, { x: 4, z: 4 }, { x: 0, z: 4 });
    expect(findRegions(plan)).toHaveLength(0);

    drawWall(plan, { x: 0, z: 4 }, { x: 0, z: 0 });
    expect(findRegions(plan)).toHaveLength(1);
    expect(findRegions(plan)[0]!.area).toBeCloseTo(16, 4);
  });

  it('refuses to create a wall with no length', () => {
    const plan = emptyPlan();
    expect(drawWall(plan, { x: 1, z: 1 }, { x: 1.01, z: 1 })).toBeNull();
    expect(plan.walls).toHaveLength(0);
  });
});

describe('room appearance', () => {
  it('keeps a room its colour when a wall is merely moved', () => {
    const plan = createDefaultPlan();
    const key = findRegions(plan)[0]!.key;
    setRoomSpec(plan, key, { name: 'Studio', wall: { color: '#a8b3a0', roughness: 0.9 } });

    moveVertex(plan, plan.vertices[0]!.id, { x: -3, z: -3 });
    normalizePlan(plan);

    const after = findRegions(plan)[0]!;
    expect(resolveRoomSpec(plan, after.key).name).toBe('Studio');
  });

  it('lets a split room inherit its colour rather than resetting it', () => {
    // A room divided in two should give two sage rooms, not two default ones.
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 6, 3);
    const key = findRegions(plan)[0]!.key;
    setRoomSpec(plan, key, { name: 'Sage Room', wall: { color: '#a8b3a0', roughness: 0.9 } });

    // Split the top and bottom walls, then join the new corners with a partition.
    const top = plan.walls[0]!;
    const bottom = plan.walls[2]!;
    const a = splitWall(plan, top.id, 0.5)!;
    const b = splitWall(plan, bottom.id, 0.5)!;
    const va = plan.vertices.find((vertex) => vertex.id === a)!;
    const vb = plan.vertices.find((vertex) => vertex.id === b)!;
    drawWall(plan, { x: va.x, z: va.z }, { x: vb.x, z: vb.z });

    const regions = findRegions(plan);
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(resolveRoomSpec(plan, region.key).wall.color).toBe('#a8b3a0');
    }
  });
});

describe('deleteWall', () => {
  it('opens the room up and tidies away the corners it orphaned', () => {
    const plan = emptyPlan();
    addRectangle(plan, { x: 0, z: 0 }, 4, 3);

    deleteWall(plan, plan.walls[0]!.id);

    expect(plan.walls).toHaveLength(3);
    expect(findRegions(plan)).toHaveLength(0);
    // Every surviving vertex is still attached to something.
    for (const vertex of plan.vertices) {
      expect(
        plan.walls.some((wall) => wall.start === vertex.id || wall.end === vertex.id),
      ).toBe(true);
    }
  });
});
