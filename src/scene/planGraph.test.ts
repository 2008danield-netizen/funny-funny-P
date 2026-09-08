/**
 * Tests for room detection.
 *
 * This is the algorithm session 2 rests on: if `findRegions` is wrong, floors
 * appear in the wrong places, paint lands on the wrong side of a wall, and the
 * room list lies about what the user has drawn. None of that is obvious from a
 * screenshot — an L-shaped room with a subtly wrong area still looks like an
 * L-shaped room — which is exactly why it is tested rather than eyeballed.
 */

import { describe, expect, it } from 'vitest';

import { findRegions, planBounds, pointInPolygon, regionKey, totalFloorArea } from './planGraph';
import type { PlanModel, Point2 } from '@/state/types';
import { defaultRoomSpec } from '@/state/defaults';

/** Builds a plan from a list of named corners and the walls joining them. */
function makePlan(
  corners: Record<string, Point2>,
  edges: Array<[string, string]>,
): PlanModel {
  return {
    vertices: Object.entries(corners).map(([id, point]) => ({ id, x: point.x, z: point.z })),
    walls: edges.map(([start, end], index) => ({
      id: `w${index + 1}`,
      start,
      end,
      thickness: 0.12,
      height: 2.6,
      faces: {},
      openings: [],
    })),
    rooms: {},
    defaultRoom: defaultRoomSpec(),
    defaultWallHeight: 2.6,
    defaultWallThickness: 0.12,
  };
}

/** A closed loop through the given corner names. */
function loop(...names: string[]): Array<[string, string]> {
  return names.map((name, index) => [name, names[(index + 1) % names.length]!] as [string, string]);
}

describe('findRegions', () => {
  it('finds a single rectangular room and measures it', () => {
    const plan = makePlan(
      {
        a: { x: 0, z: 0 },
        b: { x: 4, z: 0 },
        c: { x: 4, z: 3 },
        d: { x: 0, z: 3 },
      },
      loop('a', 'b', 'c', 'd'),
    );

    const regions = findRegions(plan);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(12, 6);
    expect(regions[0]!.polygon).toHaveLength(4);
  });

  it('measures an L-shaped room correctly', () => {
    // A 6 x 4 rectangle with a 2 x 2 bite taken out of one corner: 24 - 4 = 20.
    const plan = makePlan(
      {
        a: { x: 0, z: 0 },
        b: { x: 6, z: 0 },
        c: { x: 6, z: 2 },
        d: { x: 4, z: 2 },
        e: { x: 4, z: 4 },
        f: { x: 0, z: 4 },
      },
      loop('a', 'b', 'c', 'd', 'e', 'f'),
    );

    const regions = findRegions(plan);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(20, 6);
  });

  it('splits one space into two rooms when a partition is added', () => {
    // A 6 x 3 rectangle divided down the middle by a wall from m1 to m2.
    const plan = makePlan(
      {
        a: { x: 0, z: 0 },
        m1: { x: 3, z: 0 },
        b: { x: 6, z: 0 },
        c: { x: 6, z: 3 },
        m2: { x: 3, z: 3 },
        d: { x: 0, z: 3 },
      },
      [
        ['a', 'm1'],
        ['m1', 'b'],
        ['b', 'c'],
        ['c', 'm2'],
        ['m2', 'd'],
        ['d', 'a'],
        // The partition.
        ['m1', 'm2'],
      ],
    );

    const regions = findRegions(plan);
    expect(regions).toHaveLength(2);
    for (const region of regions) expect(region.area).toBeCloseTo(9, 6);
    expect(totalFloorArea(regions)).toBeCloseTo(18, 6);
  });

  it('records which side of a shared wall faces each room', () => {
    const plan = makePlan(
      {
        a: { x: 0, z: 0 },
        m1: { x: 3, z: 0 },
        b: { x: 6, z: 0 },
        c: { x: 6, z: 3 },
        m2: { x: 3, z: 3 },
        d: { x: 0, z: 3 },
      },
      [
        ['a', 'm1'],
        ['m1', 'b'],
        ['b', 'c'],
        ['c', 'm2'],
        ['m2', 'd'],
        ['d', 'a'],
        ['m1', 'm2'],
      ],
    );

    const regions = findRegions(plan);
    const partitionId = 'w7';

    // Both rooms border the partition, and they must border OPPOSITE faces of
    // it — otherwise painting one room would repaint the other's side too.
    const sides = regions
      .map((region) => region.facing[partitionId])
      .filter((side): side is 'a' | 'b' => side !== undefined);

    expect(sides).toHaveLength(2);
    expect(new Set(sides).size).toBe(2);
  });

  it('ignores a dangling wall that encloses nothing', () => {
    const plan = makePlan(
      {
        a: { x: 0, z: 0 },
        b: { x: 4, z: 0 },
        c: { x: 4, z: 3 },
        d: { x: 0, z: 3 },
        stub: { x: 6, z: 1.5 },
      },
      [...loop('a', 'b', 'c', 'd'), ['b', 'stub']],
    );

    const regions = findRegions(plan);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(12, 6);
  });

  it('finds rooms in two disconnected structures', () => {
    // Two separate rectangles. Each connected component has its own outer face,
    // so a single global "discard the biggest face" rule would lose one room.
    const plan = makePlan(
      {
        a: { x: 0, z: 0 },
        b: { x: 2, z: 0 },
        c: { x: 2, z: 2 },
        d: { x: 0, z: 2 },
        p: { x: 10, z: 0 },
        q: { x: 14, z: 0 },
        r: { x: 14, z: 3 },
        s: { x: 10, z: 3 },
      },
      [...loop('a', 'b', 'c', 'd'), ...loop('p', 'q', 'r', 's')],
    );

    const regions = findRegions(plan);
    expect(regions).toHaveLength(2);
    // Sorted largest first.
    expect(regions[0]!.area).toBeCloseTo(12, 6);
    expect(regions[1]!.area).toBeCloseTo(4, 6);
  });

  it('finds no rooms when the loop is left open', () => {
    const plan = makePlan(
      {
        a: { x: 0, z: 0 },
        b: { x: 4, z: 0 },
        c: { x: 4, z: 3 },
        d: { x: 0, z: 3 },
      },
      // Three walls only: the fourth side is missing, so nothing is enclosed.
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
      ],
    );

    expect(findRegions(plan)).toHaveLength(0);
  });

  it('keeps a room identity stable when its walls move', () => {
    const before = makePlan(
      {
        a: { x: 0, z: 0 },
        b: { x: 4, z: 0 },
        c: { x: 4, z: 3 },
        d: { x: 0, z: 3 },
      },
      loop('a', 'b', 'c', 'd'),
    );

    // The same walls, one corner dragged outwards. The room grew, but it is
    // still the same room, so its floor and paint must not reset.
    const after = makePlan(
      {
        a: { x: 0, z: 0 },
        b: { x: 7, z: 0 },
        c: { x: 4, z: 3 },
        d: { x: 0, z: 3 },
      },
      loop('a', 'b', 'c', 'd'),
    );

    expect(findRegions(after)[0]!.key).toBe(findRegions(before)[0]!.key);
  });

  it('produces anticlockwise polygons regardless of how walls were drawn', () => {
    // The same square traced the other way round. Downstream geometry assumes
    // one winding, so detection has to normalise it.
    const clockwise = makePlan(
      {
        a: { x: 0, z: 0 },
        b: { x: 4, z: 0 },
        c: { x: 4, z: 3 },
        d: { x: 0, z: 3 },
      },
      loop('d', 'c', 'b', 'a'),
    );

    const region = findRegions(clockwise)[0]!;
    let signed = 0;
    for (let i = 0; i < region.polygon.length; i++) {
      const p = region.polygon[i]!;
      const q = region.polygon[(i + 1) % region.polygon.length]!;
      signed += p.x * q.z - q.x * p.z;
    }
    expect(signed / 2).toBeGreaterThan(0);
  });

  it('gives an L-shaped room a reference point that is actually inside it', () => {
    const plan = makePlan(
      {
        a: { x: 0, z: 0 },
        b: { x: 6, z: 0 },
        c: { x: 6, z: 2 },
        d: { x: 2, z: 2 },
        e: { x: 2, z: 6 },
        f: { x: 0, z: 6 },
      },
      loop('a', 'b', 'c', 'd', 'e', 'f'),
    );

    const region = findRegions(plan)[0]!;
    // The area-weighted centroid of this L is (2.2, 2.2), which sits in the
    // notch between the arms -- outside the room. The interior point must not.
    expect(pointInPolygon({ x: 2.2, z: 2.2 }, region.polygon)).toBe(false);
    expect(pointInPolygon(region.interiorPoint, region.polygon)).toBe(true);
  });
});

describe('regionKey', () => {
  it('does not depend on the order walls were traversed in', () => {
    expect(regionKey(['w3', 'w1', 'w2'])).toBe(regionKey(['w1', 'w2', 'w3']));
  });
});

describe('planBounds', () => {
  it('measures the footprint and stays usable for an empty plan', () => {
    const plan = makePlan(
      {
        a: { x: -2, z: -1 },
        b: { x: 4, z: -1 },
        c: { x: 4, z: 3 },
        d: { x: -2, z: 3 },
      },
      loop('a', 'b', 'c', 'd'),
    );

    const bounds = planBounds(plan);
    expect(bounds.width).toBeCloseTo(6, 6);
    expect(bounds.depth).toBeCloseTo(4, 6);
    expect(bounds.center.x).toBeCloseTo(1, 6);

    const empty = makePlan({}, []);
    // A zero-radius bound would make the camera framing divide by zero.
    expect(planBounds(empty).radius).toBeGreaterThan(0);
  });
});
