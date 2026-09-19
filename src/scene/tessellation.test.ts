/**
 * The segment counts are arithmetic, so they can be checked against the
 * arithmetic — and the arithmetic is the point. A test that merely asserted
 * "sixteen sides" would be the same hard-coded guess this module replaced.
 */

import { describe, expect, it } from 'vitest';

import {
  CHORD_ERROR,
  MAX_SEGMENTS,
  MIN_SEGMENTS,
  cornerSegments,
  radialSegments,
  sphereSegments,
} from './tessellation';

/** How far a chord of this many segments actually departs from the circle. */
function sagitta(radius: number, segments: number, arc = Math.PI * 2): number {
  return radius * (1 - Math.cos(arc / segments / 2));
}

describe('radialSegments', () => {
  it('keeps the chord within the permitted error, up to where the cap bites', () => {
    // The guarantee holds up to about 187 mm, where MAX_SEGMENTS takes over
    // and it becomes a budget instead. Below that, the error is held.
    for (const radius of [0.005, 0.01, 0.02, 0.05, 0.1, 0.18]) {
      const segments = radialSegments(radius);
      // A little slack for the ceiling and for floating point; the claim is
      // that the error is held, not that it is held to the last bit.
      expect(sagitta(radius, segments)).toBeLessThan(CHORD_ERROR * 1.05);
    }
  });

  it('lets the error grow past the cap, but only to something invisible', () => {
    /*
     * The trade MAX_SEGMENTS makes, stated as a number rather than left
     * implicit. A half-metre column is drawn with forty-eight sides and wobbles
     * by about a millimetre, which nobody sees on something that size — and
     * which the formula would have spent a hundred and eleven sides removing.
     */
    expect(radialSegments(0.5)).toBe(MAX_SEGMENTS);
    expect(sagitta(0.5, MAX_SEGMENTS)).toBeLessThan(0.0015);
  });

  it('asks for more sides as the thing gets bigger', () => {
    const small = radialSegments(0.01);
    const medium = radialSegments(0.05);
    const large = radialSegments(0.2);
    expect(medium).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(medium);
  });

  it('gives a handrail enough sides to stop being a hexagon', () => {
    // The stair baluster was on six. At 20 mm that is a visible polygon.
    expect(radialSegments(0.02)).toBeGreaterThanOrEqual(14);
  });

  it('needs fewer segments for a shorter arc, in proportion', () => {
    const full = radialSegments(0.1, Math.PI * 2);
    const quarter = radialSegments(0.1, Math.PI / 2);
    // A quarter of the turn at the same smoothness, give or take the rounding
    // and the floor.
    expect(quarter).toBeLessThan(full);
    expect(quarter * 4).toBeGreaterThanOrEqual(full - 4);
  });

  it('holds its floor and its ceiling', () => {
    expect(radialSegments(0.0001)).toBe(MIN_SEGMENTS);
    expect(radialSegments(50)).toBe(MAX_SEGMENTS);
  });

  it('refuses to produce nonsense from nonsense', () => {
    expect(radialSegments(0)).toBe(MIN_SEGMENTS);
    expect(radialSegments(-1)).toBe(MIN_SEGMENTS);
    // A zero arc has no floor of eight to fall back on — eight sides on
    // nothing is eight sides of waste. The floor scales with the arc.
    expect(radialSegments(0.1, 0)).toBe(2);
  });

  it('spends fewer segments when detail is turned down', () => {
    const full = radialSegments(0.2, Math.PI * 2, 1);
    const half = radialSegments(0.2, Math.PI * 2, 0.5);
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThanOrEqual(MIN_SEGMENTS);
  });

  it('always returns a whole number', () => {
    for (const radius of [0.003, 0.017, 0.14, 0.9]) {
      expect(Number.isInteger(radialSegments(radius))).toBe(true);
    }
  });
});

describe('sphereSegments', () => {
  it('puts half as many rings as segments, so triangles stay square-ish', () => {
    const { width, height } = sphereSegments(0.1);
    expect(height).toBeGreaterThanOrEqual(width / 2 - 2);
    expect(height).toBeLessThanOrEqual(width / 2 + 2);
  });

  it('keeps an even ring count, so there is one on the equator', () => {
    for (const radius of [0.008, 0.05, 0.12, 0.4]) {
      expect(sphereSegments(radius).height % 2).toBe(0);
    }
  });

  it('never drops below a shape that still reads as a sphere', () => {
    const { width, height } = sphereSegments(0.001);
    expect(width).toBeGreaterThanOrEqual(MIN_SEGMENTS);
    expect(height).toBeGreaterThanOrEqual(6);
  });
});

describe('the arc, and the floor that scales with it', () => {
  it('does not give a quarter round the whole circle\'s minimum', () => {
    /*
     * The mistake the first version made. MIN_SEGMENTS is eight sides on a full
     * circle; applying the same eight to a quarter makes it four times smoother
     * than the cylinder beside it, on exactly the tiny eased edges there are
     * thousands of.
     */
    expect(radialSegments(0.002, Math.PI / 2)).toBeLessThan(MIN_SEGMENTS);
    expect(radialSegments(0.002, Math.PI * 2)).toBe(MIN_SEGMENTS);
  });

  it('keeps a small chamfer to a couple of segments', () => {
    // A 2 mm eased edge, which is on every box in the building.
    expect(cornerSegments(0.002)).toBeLessThanOrEqual(3);
  });
});

describe('cornerSegments', () => {
  it('always rounds rather than cutting a flat', () => {
    // One segment across a corner is a chamfer, not a fillet.
    for (const radius of [0.0005, 0.002, 0.01, 0.05]) {
      expect(cornerSegments(radius)).toBeGreaterThanOrEqual(2);
    }
  });

  it('stays cheap, because these are everywhere', () => {
    expect(cornerSegments(0.5)).toBeLessThanOrEqual(8);
  });

  it('gives a bigger fillet more segments than a tiny one', () => {
    expect(cornerSegments(0.03)).toBeGreaterThanOrEqual(cornerSegments(0.002));
  });
});
