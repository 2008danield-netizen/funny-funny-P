/**
 * Tests for collision detection and resolution.
 *
 * The promise session 3 makes is that furniture cannot end up inside a wall or
 * inside another piece. That promise is only as good as this file: a solver
 * that is nearly right produces a sofa half-buried in a wall, which looks
 * plausible in a screenshot and is completely wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  obbCorners,
  obbInsidePolygon,
  obbIntersects,
  snapToWall,
  solvePosition,
  testObb,
  type Collider,
  type Obb,
} from './collision';

function box(x: number, z: number, width: number, depth: number, rotation = 0): Obb {
  return {
    center: { x, z },
    halfWidth: width / 2,
    halfDepth: depth / 2,
    rotation,
  };
}

function wall(x: number, z: number, length: number, thickness: number, rotation = 0): Collider {
  return { kind: 'wall', id: 'w1', ...box(x, z, length, thickness, rotation) };
}

describe('testObb', () => {
  it('finds no overlap between boxes that are apart', () => {
    expect(testObb(box(0, 0, 1, 1), box(5, 0, 1, 1))).toBeNull();
  });

  it('finds an overlap between boxes that intersect', () => {
    expect(testObb(box(0, 0, 2, 2), box(1, 0, 2, 2))).not.toBeNull();
  });

  it('measures the overlap depth correctly', () => {
    // Two 2 m boxes 1.5 m apart overlap by 0.5 m along X.
    const overlap = testObb(box(0, 0, 2, 2), box(1.5, 0, 2, 2));
    expect(overlap).not.toBeNull();
    expect(overlap!.depth).toBeCloseTo(0.5, 6);
    // The push must be away from the other box, i.e. towards -X.
    expect(overlap!.axis.x).toBeCloseTo(-1, 6);
  });

  it('takes the shortest way out, not the first axis it finds', () => {
    // A wide, shallow overlap: 3 m of shared width but only 0.2 m of depth.
    const overlap = testObb(box(0, 0, 4, 1), box(0, 0.9, 4, 1));
    expect(overlap!.depth).toBeCloseTo(0.1, 6);
    expect(Math.abs(overlap!.axis.z)).toBeCloseTo(1, 6);
  });

  it('handles rotated boxes', () => {
    // A 45-degree diamond overlapping an axis-aligned square.
    const rotated = box(1.2, 0, 2, 2, Math.PI / 4);
    expect(obbIntersects(box(0, 0, 2, 2), rotated)).toBe(true);

    const clear = box(3.5, 0, 2, 2, Math.PI / 4);
    expect(obbIntersects(box(0, 0, 2, 2), clear)).toBe(false);
  });

  it('separates boxes that merely touch, once padding is applied', () => {
    // Exactly touching: no overlap without padding, overlap with it. This is
    // what keeps a sofa resting against a wall from flickering.
    const a = box(0, 0, 2, 2);
    const b = box(2, 0, 2, 2);
    expect(testObb(a, b, 0)).toBeNull();
    expect(testObb(a, b, 0.01)).not.toBeNull();
  });
});

describe('obbCorners', () => {
  it('places corners correctly for an unrotated box', () => {
    const corners = obbCorners(box(0, 0, 2, 4));
    const xs = corners.map((corner) => corner.x).sort((p, q) => p - q);
    const zs = corners.map((corner) => corner.z).sort((p, q) => p - q);
    expect(xs[0]).toBeCloseTo(-1, 6);
    expect(xs[3]).toBeCloseTo(1, 6);
    expect(zs[0]).toBeCloseTo(-2, 6);
    expect(zs[3]).toBeCloseTo(2, 6);
  });

  it('swaps the extents when a box is turned a quarter turn', () => {
    const corners = obbCorners(box(0, 0, 2, 4, Math.PI / 2));
    const xs = corners.map((corner) => corner.x);
    expect(Math.max(...xs)).toBeCloseTo(2, 6);
  });
});

describe('solvePosition', () => {
  const padding = 0.002;

  it('leaves a box alone when nothing is in the way', () => {
    const result = solvePosition(box(0, 0, 1, 1), {
      colliders: [wall(0, 5, 6, 0.2)],
      padding,
      iterations: 6,
    });
    expect(result.resolved).toBe(true);
    expect(result.center.x).toBeCloseTo(0, 6);
    expect(result.center.z).toBeCloseTo(0, 6);
  });

  it('pushes a box out of a wall it was dropped into', () => {
    // A 2 x 1 sofa dropped straight onto a wall lying along X at z = 0.
    const result = solvePosition(box(0, 0, 2, 1), {
      colliders: [wall(0, 0, 6, 0.2)],
      padding,
      iterations: 6,
    });

    expect(result.resolved).toBe(true);
    // Clear of the wall: half the sofa's depth plus half the wall's, or more.
    expect(Math.abs(result.center.z)).toBeGreaterThanOrEqual(0.5 + 0.1);
    expect(result.blockedBy).toContain('w1');
  });

  it('slides along a wall instead of stopping dead', () => {
    // Pushed diagonally into a wall: the sideways part of the motion survives.
    const result = solvePosition(box(1.5, 0.05, 2, 1), {
      colliders: [wall(0, 0, 8, 0.2)],
      padding,
      iterations: 6,
    });

    expect(result.resolved).toBe(true);
    // X is untouched — only the component into the wall was cancelled.
    expect(result.center.x).toBeCloseTo(1.5, 6);
    expect(result.center.z).toBeGreaterThan(0.5);
  });

  it('resolves a box overlapping two things at once', () => {
    const colliders: Collider[] = [
      { kind: 'wall', id: 'north', ...box(0, 0, 8, 0.2) },
      { kind: 'furniture', id: 'table', ...box(0.6, 0.7, 1, 1) },
    ];

    const result = solvePosition(box(0, 0.2, 1, 1), {
      colliders,
      padding,
      iterations: 8,
    });

    expect(result.resolved).toBe(true);
    for (const collider of colliders) {
      expect(obbIntersects({ ...box(0, 0, 1, 1), center: result.center }, collider)).toBe(false);
    }
  });

  it('refuses a position with no way out rather than fudging one', () => {
    // A 2 m box asked to fit in a 1 m slot between two walls. There is no legal
    // answer, and inventing one would put furniture inside a wall.
    // Two walls running along Z, their inner faces 1.8 m apart. Note the lack
    // of rotation: `box(w, d)` is already 0.2 m across and 6 m deep, so turning
    // it a quarter turn as well would lay both walls flat.
    const colliders: Collider[] = [
      { kind: 'wall', id: 'left', ...box(-1.0, 0, 0.2, 6) },
      { kind: 'wall', id: 'right', ...box(1.0, 0, 0.2, 6) },
    ];

    const result = solvePosition(box(0, 0, 2.6, 1), {
      colliders,
      padding,
      iterations: 6,
    });
    expect(result.resolved).toBe(false);
  });

  it('rejects a position the caller deems invalid even when nothing overlaps', () => {
    // Nothing to collide with, but the point is outside every room.
    const result = solvePosition(box(50, 50, 1, 1), {
      colliders: [],
      padding,
      iterations: 4,
      isPositionValid: () => false,
    });
    expect(result.resolved).toBe(false);
  });
});

describe('snapToWall', () => {
  const padding = 0.002;

  it('seats a piece flush against a nearby wall', () => {
    // Wall along X at z = -2, thickness 0.2, so its inner face is at z = -1.9.
    const theWall = wall(0, -2, 6, 0.2);
    const sofa = box(0, -1.5, 2, 0.9);

    const snapped = snapToWall(sofa, [theWall], 0.5, padding);
    expect(snapped).not.toBeNull();

    // The sofa's back edge should end up on the wall's face, which puts its
    // centre one half-depth further into the room.
    expect(snapped!.center.z).toBeCloseTo(-2 + 0.1 + 0.45 + padding, 4);
  });

  it('turns the piece to FACE the room, not the wall', () => {
    // The regression this guards: getting the rotation sign wrong seats a sofa
    // facing into the wall, which looks almost right and is entirely wrong.
    const theWall = wall(0, -2, 6, 0.2);
    const snapped = snapToWall(box(0, -1.5, 2, 0.9), [theWall], 0.5, padding);
    expect(snapped).not.toBeNull();

    // A box's local +Z (its front) is (-sin r, cos r). With the wall to the
    // piece's -Z side, the front must point towards +Z.
    const front = { x: -Math.sin(snapped!.rotation), z: Math.cos(snapped!.rotation) };
    expect(front.z).toBeGreaterThan(0.9);
  });

  it('faces the other way for a wall on the opposite side', () => {
    const theWall = wall(0, 2, 6, 0.2);
    const snapped = snapToWall(box(0, 1.5, 2, 0.9), [theWall], 0.5, padding);
    expect(snapped).not.toBeNull();

    const front = { x: -Math.sin(snapped!.rotation), z: Math.cos(snapped!.rotation) };
    expect(front.z).toBeLessThan(-0.9);
  });

  it('handles a wall running the other axis', () => {
    // Wall along Z at x = -3.
    const theWall = wall(-3, 0, 6, 0.2, Math.PI / 2);
    const snapped = snapToWall(box(-2.4, 0, 2, 0.9), [theWall], 0.6, padding);
    expect(snapped).not.toBeNull();

    const front = { x: -Math.sin(snapped!.rotation), z: Math.cos(snapped!.rotation) };
    // Should face towards +X, away from the wall.
    expect(front.x).toBeGreaterThan(0.9);
    expect(snapped!.center.x).toBeCloseTo(-3 + 0.1 + 0.45 + padding, 4);
  });

  it('ignores walls that are too far away', () => {
    expect(snapToWall(box(0, 0, 2, 0.9), [wall(0, -5, 6, 0.2)], 0.5, padding)).toBeNull();
  });

  it('ignores a wall the piece is past the end of', () => {
    // The wall spans x in [-1, 1]; the piece sits at x = 12, nowhere near it.
    expect(snapToWall(box(12, -1.5, 2, 0.9), [wall(0, -2, 2, 0.2)], 0.5, padding)).toBeNull();
  });
});

describe('obbInsidePolygon', () => {
  const room = [
    { x: -2, z: -2 },
    { x: 2, z: -2 },
    { x: 2, z: 2 },
    { x: -2, z: 2 },
  ];

  it('accepts a box wholly inside', () => {
    expect(obbInsidePolygon(box(0, 0, 1, 1), room)).toBe(true);
  });

  it('rejects a box hanging over the edge', () => {
    expect(obbInsidePolygon(box(1.8, 0, 1, 1), room)).toBe(false);
  });

  it('accounts for rotation', () => {
    // A 3 m box fits inside a 4 m room square-on, but turned 45 degrees its
    // diagonal is 4.24 m and the corners push through the walls.
    expect(obbInsidePolygon(box(0, 0, 3, 3), room)).toBe(true);
    expect(obbInsidePolygon(box(0, 0, 3, 3, Math.PI / 4), room)).toBe(false);
  });
});
